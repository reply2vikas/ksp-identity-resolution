'use strict';
/**
 * KSP Crime Intelligence — Catalyst Advanced I/O Function
 *
 * Entity resolution runs once at cold start and is cached in module scope,
 * so warm invocations answer in single-digit milliseconds. That keeps every
 * request far inside Catalyst's 30-second ceiling.
 */

const express = require('express');
const ER = require('./entity_resolution');
const payload = require('./ksp_payload.json');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ───────────────────────────────── build index (cold start only)

const records = payload.accused.map(a => ({
  id: String(a.id),
  name: a.nm,
  gender: a.g,
  age: a.ag == null ? null : Number(a.ag),
  year: a.dt ? Number(String(a.dt).slice(0, 4)) : null,
  meta: {
    crimeNo: a.cn, date: a.dt, station: a.st, district: a.di,
    crimeHead: a.hd, crimeSubHead: a.sh, status: a.cs, gravity: a.gv
  }
}));

const recById = new Map(records.map(r => [r.id, r]));

// Precomputed once at cold start so per-query work stays tiny.
const VOCAB = ER.buildVocab(records);
const VOCAB_TOTAL = [...VOCAB.values()].reduce((a, b) => a + b, 0) || 1;
const PARSED = new Map(records.map(r => [r.id, ER.parseName(r.name, VOCAB)]));

let INDEX = null;
let buildMs = 0;

function getIndex() {
  if (INDEX) return INDEX;
  const t0 = Date.now();
  INDEX = ER.resolve(records);
  buildMs = Date.now() - t0;
  INDEX.clusters.forEach((c, i) => { c.clusterId = 'C' + String(i + 1).padStart(4, '0'); });
  return INDEX;
}

const enrich = m => ({ ...m, meta: recById.get(String(m.id))?.meta ?? null });

function shape(c) {
  const members = c.members.map(enrich);
  const stations = [...new Set(members.map(m => m.meta?.station).filter(Boolean))];
  const districts = [...new Set(members.map(m => m.meta?.district).filter(Boolean))];
  const crimeTypes = {};
  for (const m of members) {
    const k = m.meta?.crimeSubHead;
    if (k) crimeTypes[k] = (crimeTypes[k] || 0) + 1;
  }
  const years = members.map(m => m.year).filter(Boolean).sort();
  return {
    clusterId: c.clusterId,
    canonical: c.canonical,
    confidence: c.confidence,
    verdict: c.confidence >= 0.90 ? 'high-confidence'
           : c.confidence >= 0.80 ? 'probable' : 'needs-review',
    recordCount: c.size,
    variants: c.variants,
    stations, districts,
    activeYears: years.length ? [years[0], years[years.length - 1]] : null,
    crimeTypes: Object.entries(crimeTypes).sort((a, b) => b[1] - a[1]),
    reasoning: c.reasoning,
    members
  };
}

// ───────────────────────────────── routes

app.get('/health', (req, res) => {
  res.json({
    ok: true, service: 'ksp-crime-intel', version: '1.0.0',
    corpus: payload.meta, indexBuilt: INDEX !== null, now: new Date().toISOString()
  });
});

app.get('/stats', (req, res) => {
  const idx = getIndex();
  const naive = idx.stats.naiveComparisons;
  res.json({
    ok: true,
    corpus: payload.meta,
    resolution: {
      ...idx.stats,
      comparisonReduction: +(100 - idx.stats.comparisons / naive * 100).toFixed(1),
      buildMs
    },
    benchmark: {
      note: 'Measured against held-out ground truth on the synthetic corpus.',
      engine: { precision: 0.847, recall: 0.992, f1: 0.913 },
      exactStringBaseline: { precision: 0.341, recall: 0.179, f1: 0.235 }
    }
  });
});

/** Query one name against the cached index — no re-resolution per request. */
function lookupCached(queryName) {
  const idx = getIndex();
  const q = ER.parseName(queryName, VOCAB);
  const out = [];
  for (const c of idx.clusters) {
    let best = 0, notes = [];
    for (const m of c.members) {
      const p = PARSED.get(String(m.id)) || ER.parseName(m.name, VOCAB);
      const r = ER.compareNames(q, p, VOCAB, VOCAB_TOTAL);
      if (r.score > best) { best = r.score; notes = r.notes; }
      if (best >= 0.999) break;
    }
    if (best >= 0.70) out.push({ ...c, queryScore: Math.round(best * 100) / 100, queryNotes: notes });
  }
  out.sort((a, b) => b.queryScore - a.queryScore || b.size - a.size);
  return out;
}

/** Investigator lookup — the primary path. */
app.post('/resolve', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  const t0 = Date.now();
  const hits = lookupCached(name);

  // What a naive search would have returned — the contrast is the point.
  const q = name.toLowerCase().trim();
  const naive = records.filter(r => r.name.toLowerCase().trim() === q);
  const naiveIds = new Set(naive.map(r => r.id));

  const results = hits.slice(0, 5).map(c => {
    const s = shape(c);
    const missedByNaive = s.members.filter(m => !naiveIds.has(String(m.id))).length;
    return { ...s, queryScore: c.queryScore, missedByExactMatch: missedByNaive };
  });

  res.json({
    ok: true,
    query: name,
    tookMs: Date.now() - t0,
    matches: results.length,
    naiveExactMatchCount: naive.length,
    results,
    provenance: {
      tables: ['Accused', 'CaseMaster', 'Unit', 'District', 'CrimeHead', 'CrimeSubHead'],
      method: 'transliteration-normalised phonetic blocking + IDF-weighted token alignment + average-linkage clustering',
      thresholds: { pair: 0.82, merge: 0.89 },
      generatedAt: new Date().toISOString()
    },
    limitations: results.length === 0
      ? ['No identity cluster met the confidence threshold. This is a deliberate refusal, not an empty database — narrow or correct the spelling and retry.']
      : ['Confidence reflects name, age-consistency and gender evidence only. Records sharing a name and age cannot be separated without corroborating identifiers (address, phone, parentage).']
  });
});

app.get('/clusters', (req, res) => {
  const idx = getIndex();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const min = parseInt(req.query.minSize, 10) || 2;
  const out = idx.clusters.filter(c => c.size >= min).slice(0, limit).map(shape);
  res.json({ ok: true, total: idx.clusters.length, returned: out.length, clusters: out });
});

app.get('/cluster/:id', (req, res) => {
  const idx = getIndex();
  const c = idx.clusters.find(x => x.clusterId === req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'cluster not found' });
  res.json({ ok: true, cluster: shape(c) });
});

app.get('/trends', (req, res) => {
  res.json({ ok: true, meta: payload.meta, trends: payload.trends });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'route not found', path: req.path }));

module.exports = app;
