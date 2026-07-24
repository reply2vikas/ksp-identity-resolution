'use strict';
/**
 * KSP Crime Intelligence — Entity Resolution Engine
 * ------------------------------------------------
 * Resolves the same human across FIR records despite:
 *   - transliteration variance   (Ravi / Ravee, Suresh / Suresha)
 *   - script variance            (ರವಿ ಪಾಟೀಲ್  ==  Ravi Patil)
 *   - name-order flips           (Patil Ravi  ==  Ravi Patil)
 *   - initials                   (R. Patil / Ravi P)
 *   - concatenation              (YusufKhan)
 *   - casing / whitespace noise  (RAVI  PATIL )
 *   - age drift from data entry  (32 vs 34 in the same year)
 *
 * Zero dependencies. Every match carries human-readable reasoning,
 * because an unexplained match in policing is worse than no match.
 */

// ───────────────────────────────────────────── Kannada → Latin

const KN_VOWEL = {
  'ಅ':'a','ಆ':'aa','ಇ':'i','ಈ':'ii','ಉ':'u','ಊ':'uu','ಋ':'ru',
  'ಎ':'e','ಏ':'ee','ಐ':'ai','ಒ':'o','ಓ':'oo','ಔ':'au'
};
const KN_CONS = {
  'ಕ':'k','ಖ':'kh','ಗ':'g','ಘ':'gh','ಙ':'ng',
  'ಚ':'ch','ಛ':'chh','ಜ':'j','ಝ':'jh','ಞ':'ny',
  'ಟ':'t','ಠ':'th','ಡ':'d','ಢ':'dh','ಣ':'n',
  'ತ':'t','ಥ':'th','ದ':'d','ಧ':'dh','ನ':'n',
  'ಪ':'p','ಫ':'ph','ಬ':'b','ಭ':'bh','ಮ':'m',
  'ಯ':'y','ರ':'r','ಱ':'r','ಲ':'l','ಳ':'l','ವ':'v',
  'ಶ':'sh','ಷ':'sh','ಸ':'s','ಹ':'h'
};
const KN_MATRA = {
  'ಾ':'aa','ಿ':'i','ೀ':'ii','ು':'u','ೂ':'uu','ೃ':'ru',
  'ೆ':'e','ೇ':'ee','ೈ':'ai','ೊ':'o','ೋ':'oo','ೌ':'au'
};
const KN_VIRAMA = '್';
const KN_ANUSVARA = 'ಂ';
const KN_VISARGA = 'ಃ';

function hasKannada(s) { return /[\u0C80-\u0CFF]/.test(s); }

/** Syllable-aware Kannada transliteration (inherent 'a' honoured, virama suppresses it). */
function translitKannada(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (KN_CONS[ch]) {
      out += KN_CONS[ch];
      const nxt = str[i + 1];
      if (nxt === KN_VIRAMA) { i++; }                       // dead consonant
      else if (KN_MATRA[nxt]) { out += KN_MATRA[nxt]; i++; } // explicit vowel
      else { out += 'a'; }                                   // inherent vowel
    } else if (KN_VOWEL[ch]) {
      out += KN_VOWEL[ch];
    } else if (ch === KN_ANUSVARA) {
      out += 'n';
    } else if (ch === KN_VISARGA) {
      out += 'h';
    } else if (!KN_MATRA[ch] && ch !== KN_VIRAMA) {
      out += ch;
    }
  }
  return out;
}

// ───────────────────────────────────────────── normalization

// NOTE: single letters are deliberately NOT listed here. "D. Hegde" carries a
// real initial; dropping it as a d/o fragment destroys the strongest link.
// Relationship markers are stripped as whole units below instead.
const HONORIFICS = new Set([
  'mr','mrs','ms','shri','sri','smt','kum','dr','prof','late',
  'sardar','md','mohd','alias'
]);

function baseNormalize(raw) {
  let s = String(raw || '');
  if (hasKannada(s)) s = translitKannada(s);
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');  // strip diacritics
  s = s.toLowerCase();

  // relationship markers, as whole units: "ravi s/o suresh" → "ravi suresh"
  s = s.replace(/\b[swd]\s*[\/.]\s*o\b/g, ' ');

  s = s.replace(/[^a-z\s.]/g, ' ');

  // Data-entry repair: a period *inside* a word is a slip, not an initial.
  // "R.avi" → "ravi"   (join)
  // "R. Patil" → "r patil"  (keep as initial — space is the signal)
  s = s.replace(/\b([a-z])\.([a-z]{2,})/g, '$1$2');

  s = s.replace(/\./g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Phonetic key tuned for Indian names — NOT Soundex.
 * Soundex was built for Anglo surnames and collapses distinct Indian
 * names while splitting identical ones. This targets the actual
 * transliteration axes: aspiration, retroflex/dental, vowel length.
 */
function phoneticKey(tok) {
  let s = tok.toLowerCase();
  s = s.replace(/[^a-z]/g, '');
  if (!s) return '';

  // aspiration is inconsistently transliterated → drop it
  s = s.replace(/bh/g, 'b').replace(/ch/g, 'c').replace(/dh/g, 'd')
       .replace(/gh/g, 'g').replace(/jh/g, 'j').replace(/kh/g, 'k')
       .replace(/ph/g, 'f').replace(/th/g, 't').replace(/sh/g, 's');
  s = s.replace(/ck/g, 'k').replace(/qu/g, 'k').replace(/q/g, 'k');
  s = s.replace(/x/g, 'ks').replace(/z/g, 'j');
  s = s.replace(/w/g, 'v');                 // Viswa / Vishwa
  s = s.replace(/ph/g, 'f');

  // vowel length is noise
  s = s.replace(/aa+/g, 'a').replace(/ee+/g, 'i').replace(/oo+/g, 'u')
       .replace(/ii+/g, 'i').replace(/uu+/g, 'u');
  s = s.replace(/ai/g, 'e').replace(/au/g, 'o').replace(/ay/g, 'e');
  s = s.replace(/y/g, 'i');

  // collapse doubles
  s = s.replace(/(.)\1+/g, '$1');

  // keep first letter, reduce interior vowels
  const head = s[0];
  let tail = s.slice(1).replace(/[aeiou]/g, '');
  s = head + tail;

  s = s.replace(/(.)\1+/g, '$1');
  return s;
}

// ───────────────────────────────────────────── similarity

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - md), hi = Math.min(i + md + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true; m++; break;
    }
  }
  if (!m) return 0;
  let k = 0, t = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const j = (m / a.length + m / b.length + (m - t) / m) / 3;
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

// ───────────────────────────────────────────── vocabulary + splitting

/** Build a lexicon of real name tokens observed across the corpus. */
function buildVocab(records) {
  const freq = new Map();
  for (const r of records) {
    const toks = baseNormalize(r.name).split(' ').filter(t => t.length >= 3);
    if (toks.length >= 2) for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq;
}

/** "yusufkhan" → ["yusuf","khan"] when both halves are known names. */
function splitConcat(tok, vocab) {
  if (tok.length < 6) return null;
  let best = null;
  for (let i = 3; i <= tok.length - 3; i++) {
    const l = tok.slice(0, i), r = tok.slice(i);
    const fl = vocab.get(l) || 0, fr = vocab.get(r) || 0;
    if (fl && fr) {
      const score = Math.min(fl, fr);
      if (!best || score > best.score) best = { parts: [l, r], score };
    }
  }
  return best ? best.parts : null;
}

// ───────────────────────────────────────────── name parsing

function parseName(raw, vocab) {
  const norm = baseNormalize(raw);
  let toks = norm.split(' ').filter(Boolean).filter(t => !HONORIFICS.has(t) || t.length > 2);

  // expand concatenations
  const expanded = [];
  for (const t of toks) {
    const sp = t.length >= 6 ? splitConcat(t, vocab) : null;
    if (sp) expanded.push(...sp); else expanded.push(t);
  }
  toks = expanded.filter(t => t.length >= 1);

  const full = toks.filter(t => t.length >= 2);
  const inits = toks.filter(t => t.length === 1);

  return {
    raw,
    norm,
    tokens: toks,
    fullTokens: full,
    initials: inits,
    keys: full.map(phoneticKey).filter(Boolean),
    initialSet: new Set(toks.map(t => t[0]))
  };
}

// ───────────────────────────────────────────── pairwise comparison

/**
 * Inverse-document-frequency weight for a name token.
 * "Patil" appears everywhere and proves little; a rare given name
 * is strong evidence. Weighting by rarity is what stops common
 * surnames from manufacturing false links.
 */
function idfWeight(tok, vocab, total) {
  if (!vocab || !total) return 1;
  const f = vocab.get(tok) || 1;
  const w = Math.log((total + 1) / (f + 1)) / Math.log(total + 1);
  return 0.45 + 0.55 * Math.max(0, Math.min(1, w));   // clamp to [0.45, 1.0]
}

/** Score one token against another. Initials are real but weaker evidence. */
function tokenScore(ta, tb) {
  const aInit = ta.length === 1, bInit = tb.length === 1;

  if (!aInit && !bInit) {
    if (ta === tb) return { s: 1.0, why: 'exact' };
    const ka = phoneticKey(ta), kb = phoneticKey(tb);
    if (ka && ka === kb) return { s: 0.94, why: 'phonetic' };
    const jw = jaroWinkler(ta, tb);
    if (jw >= 0.88) return { s: jw * 0.93, why: 'fuzzy' };
    // one token being a prefix of the other: "Ravi" / "Ravikum"
    if (ta.length >= 4 && tb.length >= 4 && (ta.startsWith(tb) || tb.startsWith(ta)))
      return { s: 0.82, why: 'prefix' };
    return { s: 0, why: '' };
  }
  if (aInit && bInit) return ta === tb ? { s: 0.58, why: 'both-initial' } : { s: 0, why: '' };

  const init = aInit ? ta : tb, full = aInit ? tb : ta;
  if (full[0] === init) return { s: 0.78, why: 'initial' };
  return { s: 0, why: '' };
}

/**
 * Order-insensitive greedy alignment over ALL tokens (full names and
 * initials together), weighted by token rarity.
 * Returns { score, notes } where score ∈ [0,1].
 */
function compareNames(A, B, vocab, total) {
  const notes = [];
  const a = [...A.tokens], b = [...B.tokens];
  if (!a.length || !b.length) return { score: 0, notes, matchedTokens: 0 };

  // score every candidate pairing, then take best-first (greedy assignment)
  const cand = [];
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const { s, why } = tokenScore(a[i], b[j]);
      if (s > 0) cand.push({ i, j, s, why });
    }
  cand.sort((x, y) => y.s - x.s);

  const usedA = new Set(), usedB = new Set();
  let num = 0, matched = 0;
  const wOf = t => idfWeight(t, vocab, total);

  for (const c of cand) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i); usedB.add(c.j);
    matched++;
    const w = Math.max(wOf(a[c.i]), wOf(b[c.j]));
    num += c.s * w;

    const ta = a[c.i], tb = b[c.j];
    if (c.why === 'phonetic')
      notes.push(`"${ta}" ≈ "${tb}" — same phonetic key /${phoneticKey(ta)}/`);
    else if (c.why === 'fuzzy')
      notes.push(`"${ta}" ≈ "${tb}" — ${(c.s / 0.93 * 100).toFixed(0)}% string similarity`);
    else if (c.why === 'initial')
      notes.push(`initial "${(ta.length === 1 ? ta : tb).toUpperCase()}." consistent with "${ta.length === 1 ? tb : ta}"`);
    else if (c.why === 'prefix')
      notes.push(`"${ta}" is a truncation of "${tb}"`);
  }

  // denominator = the more informative side, so extra unmatched tokens cost
  const wSum = arr => arr.reduce((s, t) => s + wOf(t), 0);
  const den = Math.max(wSum(a), wSum(b));
  if (den <= 0) return { score: 0, notes, matchedTokens: 0 };

  let score = num / den;

  // a single matched token out of two-plus on both sides is thin evidence
  if (matched === 1 && a.length >= 2 && b.length >= 2) score *= 0.6;

  return { score: Math.min(1, score), notes, matchedTokens: matched };
}

// ───────────────────────────────────────────── record scoring

function compareRecords(ra, rb, vocab, total) {
  const nm = compareNames(ra.parsed, rb.parsed, vocab, total);
  const notes = [...nm.notes];
  let score = nm.score;

  if (score < 0.45) return { score, notes, verdict: 'no-match' };

  // gender — a hard signal
  if (ra.gender && rb.gender) {
    if (ra.gender !== rb.gender) {
      notes.push(`gender conflict (${ra.gender} vs ${rb.gender}) — strong evidence against`);
      score *= 0.25;
    }
  }

  // implied birth year consistency
  if (ra.birthYear != null && rb.birthYear != null) {
    const d = Math.abs(ra.birthYear - rb.birthYear);
    if (d <= 1)      { score = Math.min(1, score + 0.08); notes.push(`implied birth year matches (${ra.birthYear} vs ${rb.birthYear})`); }
    else if (d <= 3) { score = Math.min(1, score + 0.03); notes.push(`birth year within entry-drift tolerance (±${d} yr)`); }
    else if (d <= 6) { score *= 0.88; notes.push(`birth year differs by ${d} yr — weak conflict`); }
    else             { score *= 0.45; notes.push(`birth year differs by ${d} yr — likely different people`); }
  }

  const verdict = score >= 0.86 ? 'match'
                : score >= 0.72 ? 'probable'
                : score >= 0.55 ? 'review'
                : 'no-match';

  return { score, notes, verdict };
}

// ───────────────────────────────────────────── blocking + clustering

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); this.r = new Array(n).fill(0); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return false;
    if (this.r[a] < this.r[b]) [a, b] = [b, a];
    this.p[b] = a; if (this.r[a] === this.r[b]) this.r[a]++;
    return true;
  }
}

/**
 * records: [{ id, name, gender, age, year, ...meta }]
 * Blocking keeps this near-linear instead of O(n²) — matters at KSP scale.
 */
function resolve(records, opts = {}) {
  const threshold = opts.threshold ?? 0.82;
  const vocab = buildVocab(records);
  const vocabTotal = [...vocab.values()].reduce((a, b) => a + b, 0) || 1;

  const recs = records.map((r, i) => ({
    ...r,
    idx: i,
    parsed: parseName(r.name, vocab),
    birthYear: (r.year != null && r.age != null) ? (r.year - r.age) : null
  }));

  // --- blocking: a record joins several buckets; pairs only compared within a bucket
  const blocks = new Map();
  const addBlock = (k, i) => {
    if (!k) return;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(i);
  };
  recs.forEach((r, i) => {
    for (const k of r.parsed.keys) addBlock('K:' + k, i);          // phonetic per token
    const sig = [...r.parsed.initialSet].sort().join('');
    addBlock('I:' + sig, i);                                        // sorted initials
    if (r.parsed.keys.length) addBlock('S:' + r.parsed.keys.slice().sort().join('|'), i);
  });

  const seen = new Set();
  const pairs = [];
  let compared = 0;

  for (const [, members] of blocks) {
    if (members.length > 400) continue;   // skip pathological blocks
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const i = members[x], j = members[y];
        const key = i < j ? i + ',' + j : j + ',' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        compared++;
        const res = compareRecords(recs[i], recs[j], vocab, vocabTotal);
        if (res.score >= threshold) pairs.push({ i, j, ...res });
      }
    }
  }

  // --- cluster: average-linkage agglomerative, NOT naive transitive closure.
  //
  // Why this matters: an ambiguous record like "V. Nayak" links plausibly to
  // Venkatesh Nayak, Vikram Nayak AND Vinod Naik. Union-find would chain all
  // three into one person. Requiring the *average* similarity across every
  // cross-pair to clear the bar stops one weak bridge from fusing distinct
  // identities — which in policing is the difference between an investigative
  // lead and a wrongful accusation.
  const mergeThreshold = opts.mergeThreshold ?? (threshold + 0.07);
  const scoreCache = new Map();
  const pairKey = (i, j) => (i < j ? i + ',' + j : j + ',' + i);
  for (const p of pairs) scoreCache.set(pairKey(p.i, p.j), p.score);

  function scoreOf(i, j) {
    const k = pairKey(i, j);
    if (scoreCache.has(k)) return scoreCache.get(k);
    const s = compareRecords(recs[i], recs[j], vocab, vocabTotal).score;
    scoreCache.set(k, s);
    return s;
  }

  const uf = new UnionFind(recs.length);
  const members = new Map();                       // root -> [indices]
  recs.forEach((_, i) => members.set(i, [i]));

  for (const p of [...pairs].sort((a, b) => b.score - a.score)) {
    const ra = uf.find(p.i), rb = uf.find(p.j);
    if (ra === rb) continue;
    const ma = members.get(ra), mb = members.get(rb);

    // average linkage across every cross-pair
    let sum = 0, n = 0, minS = 1;
    for (const x of ma) for (const y of mb) {
      const s = scoreOf(x, y);
      sum += s; n++; if (s < minS) minS = s;
    }
    const avg = sum / n;

    // singleton joins are judged on the pair itself; group merges must cohere
    const ok = (ma.length === 1 && mb.length === 1)
      ? p.score >= threshold
      : (avg >= mergeThreshold && minS >= threshold - 0.12);

    if (!ok) continue;
    uf.union(ra, rb);
    const root = uf.find(ra);
    const merged = ma.concat(mb);
    members.set(root, merged);
    if (root !== ra) members.delete(ra);
    if (root !== rb) members.delete(rb);
  }

  const groups = new Map();
  recs.forEach((r, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });

  const clusters = [];
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    const linking = pairs.filter(p => idxs.includes(p.i) && idxs.includes(p.j));
    const avg = linking.reduce((s, p) => s + p.score, 0) / (linking.length || 1);

    // canonical form = most frequent well-formed spelling
    const tally = new Map();
    for (const i of idxs) {
      const t = recs[i].parsed.fullTokens;
      if (t.length >= 2) {
        const c = t.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        tally.set(c, (tally.get(c) || 0) + 1);
      }
    }
    const canonical = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
                    || recs[idxs[0]].name.trim();

    const why = [];
    for (const p of linking.slice().sort((a, b) => b.score - a.score).slice(0, 6)) {
      for (const n of p.notes) if (!why.includes(n)) why.push(n);
    }

    clusters.push({
      canonical,
      confidence: Math.round(Math.min(0.99, avg) * 100) / 100,
      size: idxs.length,
      recordIds: idxs.map(i => recs[i].id),
      variants: [...new Set(idxs.map(i => recs[i].name.trim()))],
      reasoning: why.slice(0, 8),
      members: idxs.map(i => ({
        id: recs[i].id, name: recs[i].name, age: recs[i].age,
        year: recs[i].year, meta: recs[i].meta ?? null
      })).sort((a, b) => (a.year || 0) - (b.year || 0))
    });
  }

  clusters.sort((a, b) => b.size - a.size);

  return {
    clusters,
    stats: {
      records: recs.length,
      blocks: blocks.size,
      comparisons: compared,
      naiveComparisons: (recs.length * (recs.length - 1)) / 2,
      linkedPairs: pairs.length,
      clusters: clusters.length,
      recordsInClusters: clusters.reduce((s, c) => s + c.size, 0)
    }
  };
}

/** Resolve one query name against the corpus (the investigator-facing path). */
function lookup(records, queryName, opts = {}) {
  const { clusters } = resolve(records, opts);
  const vocab = buildVocab(records);
  const vocabTotal = [...vocab.values()].reduce((a, b) => a + b, 0) || 1;
  const q = parseName(queryName, vocab);

  const scored = clusters.map(c => {
    let best = 0, notes = [];
    for (const m of c.members) {
      const r = compareNames(q, parseName(m.name, vocab), vocab, vocabTotal);
      if (r.score > best) { best = r.score; notes = r.notes; }
    }
    return { ...c, queryScore: Math.round(best * 100) / 100, queryNotes: notes };
  }).filter(c => c.queryScore >= (opts.queryThreshold ?? 0.70));

  scored.sort((a, b) => b.queryScore - a.queryScore || b.size - a.size);
  return scored;
}

module.exports = {
  resolve, lookup, parseName, compareNames, compareRecords, idfWeight,
  phoneticKey, translitKannada, baseNormalize, jaroWinkler, buildVocab
};
