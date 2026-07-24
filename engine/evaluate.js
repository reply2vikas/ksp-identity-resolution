'use strict';
/**
 * Evaluate the entity resolution engine against ground truth.
 * Usage: node evaluate.js [pathToOutDir]
 */
const fs = require('fs');
const path = require('path');
const ER = require('./entity_resolution');

const OUT = process.argv[2] || path.join(__dirname, '..', 'out');

// ---- tiny CSV reader (handles quoted fields)
function readCSV(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let cur = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length)
             .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

console.log('Loading…');
const accused = readCSV(path.join(OUT, 'csv', 'Accused.csv'));
const cases   = readCSV(path.join(OUT, 'csv', 'CaseMaster.csv'));
const units   = readCSV(path.join(OUT, 'csv', 'Unit.csv'));
const truth   = JSON.parse(fs.readFileSync(path.join(OUT, 'truth.json'), 'utf8'));

const caseById = new Map(cases.map(c => [c.CaseMasterID, c]));
const unitById = new Map(units.map(u => [u.UnitID, u]));

const records = accused.map(a => {
  const c = caseById.get(a.CaseMasterID);
  const u = c ? unitById.get(c.PoliceStationID) : null;
  return {
    id: a.AccusedMasterID,
    name: a.AccusedName,
    gender: a.GenderID,
    age: a.AgeYear ? parseInt(a.AgeYear, 10) : null,
    year: c ? parseInt(c.CrimeRegisteredDate.slice(0, 4), 10) : null,
    meta: { station: u ? u.UnitName : null, crimeNo: c ? c.CrimeNo : null,
            date: c ? c.CrimeRegisteredDate : null }
  };
});

console.log(`  ${records.length} accused records\n`);

// ---- run
console.log('Resolving…');
const t0 = Date.now();
const { clusters, stats } = ER.resolve(records, { threshold: 0.78 });
const ms = Date.now() - t0;

console.log(`\n─── Performance ───────────────────────────────`);
console.log(`  runtime            ${ms} ms`);
console.log(`  blocks built       ${stats.blocks}`);
console.log(`  comparisons made   ${stats.comparisons.toLocaleString()}`);
console.log(`  naive would need   ${stats.naiveComparisons.toLocaleString()}`);
console.log(`  reduction          ${(100 - stats.comparisons / stats.naiveComparisons * 100).toFixed(1)}%`);
console.log(`  clusters found     ${stats.clusters}`);
console.log(`  records clustered  ${stats.recordsInClusters}`);

// ---- ground truth: pairwise precision / recall
const truthOf = new Map();
for (const [pid, ids] of Object.entries(truth.clusters))
  for (const id of ids) truthOf.set(String(id), pid);

const predOf = new Map();
clusters.forEach((c, ci) => c.recordIds.forEach(id => predOf.set(String(id), ci)));

function pairsOf(map) {
  const byGroup = new Map();
  for (const [id, g] of map) {
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(id);
  }
  const s = new Set();
  for (const [, ids] of byGroup) {
    ids.sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) s.add(ids[i] + '|' + ids[j]);
  }
  return s;
}

const T = pairsOf(truthOf);
const P = pairsOf(predOf);
let tp = 0;
for (const p of P) if (T.has(p)) tp++;
const fp = P.size - tp;
const fn = T.size - tp;
const precision = tp / (tp + fp || 1);
const recall    = tp / (tp + fn || 1);
const f1 = 2 * precision * recall / (precision + recall || 1);

console.log(`\n─── Accuracy (pairwise) ───────────────────────`);
console.log(`  true positives     ${tp}`);
console.log(`  false positives    ${fp}`);
console.log(`  false negatives    ${fn}`);
console.log(`  precision          ${(precision * 100).toFixed(1)}%`);
console.log(`  recall             ${(recall * 100).toFixed(1)}%`);
console.log(`  F1                 ${(f1 * 100).toFixed(1)}%`);

// ---- baseline: exact-string matching
const exact = new Map();
records.forEach(r => exact.set(String(r.id), r.name.trim().toLowerCase()));
const E = pairsOf(exact);
let etp = 0;
for (const p of E) if (T.has(p)) etp++;
const eRecall = etp / (T.size || 1);
const ePrec = etp / (E.size || 1);
console.log(`\n─── Baseline: exact string match ──────────────`);
console.log(`  precision          ${(ePrec * 100).toFixed(1)}%`);
console.log(`  recall             ${(eRecall * 100).toFixed(1)}%`);
console.log(`  → engine recovers  ${(recall / (eRecall || 1)).toFixed(1)}x more true links`);

// ---- showcase
console.log(`\n─── Top cluster ───────────────────────────────`);
const top = clusters[0];
if (top) {
  console.log(`  ${top.canonical}   confidence ${top.confidence}   ${top.size} records`);
  console.log(`  variants: ${top.variants.slice(0, 8).join('  |  ')}`);
  console.log(`  reasoning:`);
  top.reasoning.slice(0, 5).forEach(r => console.log(`    · ${r}`));
  console.log(`  timeline:`);
  top.members.slice(0, 8).forEach(m =>
    console.log(`    ${m.meta?.date}  ${String(m.name).padEnd(26)} age ${String(m.age).padEnd(3)} ${m.meta?.station}`));
}

// ---- lookup demo
console.log(`\n─── Investigator lookup: "ರವಿ ಪಾಟೀಲ್" ───────`);
const hits = ER.lookup(records, 'ರವಿ ಪಾಟೀಲ್', { queryThreshold: 0.75 });
hits.slice(0, 3).forEach(h =>
  console.log(`  ${h.canonical}  score ${h.queryScore}  ${h.size} records across ` +
              `${new Set(h.members.map(m => m.meta?.station)).size} stations`));

console.log(`\n─── Transliteration check ─────────────────────`);
['ರವಿ ಪಾಟೀಲ್', 'ಯುಸುಫ್ ಖಾನ್', 'ಮಂಜುನಾಥ್'].forEach(k =>
  console.log(`  ${k}  →  ${ER.baseNormalize(k)}`));
