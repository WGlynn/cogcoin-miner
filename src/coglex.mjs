/**
 * Coglex vocabulary helper
 *
 * Loads the 4,096-token Coglex vocabulary from @cogcoin/genesis
 * and provides pre-filtering utilities.
 *
 * The WASM encoder is the canonical path — this is just a pre-filter
 * to reject sentences with obviously-out-of-vocab words before the
 * expensive assaySentences() call.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let _vocab = null;
let _vocabSet = null;

function loadVocab() {
  if (_vocab) return _vocab;
  const path = require.resolve('@cogcoin/genesis/scoring_bundle/coglex_token_table.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  _vocab = data;

  // Build a fast-lookup Set of lowercase tokens
  _vocabSet = new Set();
  for (const [token, cat] of data.tokens) {
    _vocabSet.add(token.toLowerCase());
  }
  return _vocab;
}

/**
 * Get the Set of all Coglex tokens (lowercase).
 */
export function getVocabSet() {
  if (!_vocabSet) loadVocab();
  return _vocabSet;
}

/**
 * Check if a word is in the Coglex vocabulary (ignoring case).
 * Handles simple suffix stripping (-s, -ing, -ed, -er, -est, -ly).
 */
export function isInVocab(word) {
  if (!_vocabSet) loadVocab();
  const lower = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!lower) return true; // punctuation only — let the scorer decide

  if (_vocabSet.has(lower)) return true;

  // Try stripping common suffixes (morphological rules allow composition)
  const suffixes = ['s', 'es', 'ed', 'ing', 'er', 'est', 'ly', 'ies', 'ied'];
  for (const suf of suffixes) {
    if (!lower.endsWith(suf)) continue;

    const stem = lower.slice(0, -suf.length);
    if (stem.length < 3) continue;

    // Plain stem
    if (_vocabSet.has(stem)) return true;

    // -ing / -ed often drop trailing 'e' from the stem (bake → baking, wrestle → wrestling)
    if ((suf === 'ing' || suf === 'ed' || suf === 'er' || suf === 'est') && _vocabSet.has(stem + 'e')) return true;

    // -ies → -y / -ied → -y (try → tries/tried)
    if ((suf === 'ies' || suf === 'ied') && _vocabSet.has(stem + 'y')) return true;

    // Doubled-consonant forms: running → run, bigger → big
    if ((suf === 'ing' || suf === 'ed' || suf === 'er' || suf === 'est') && stem.length >= 3) {
      const last = stem[stem.length - 1];
      const prevLast = stem[stem.length - 2];
      if (last === prevLast && _vocabSet.has(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

/**
 * Extract words from a sentence (strip punctuation, split on whitespace).
 */
export function extractWords(sentence) {
  return sentence
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Pre-filter: rejects only sentences with MANY out-of-vocab words.
 *
 * The scorer already handles word_not_in_vocabulary rigorously with
 * the WASM encoder (which knows morphological rules we don't). This
 * filter is a soft pre-filter that only catches obvious garbage —
 * sentences where >threshold% of words have no chance of being encoded.
 *
 * Default threshold 0.5 = reject if majority of words are out-of-vocab.
 */
export function preFilterVocab(sentences, threshold = 0.5) {
  if (!_vocabSet) loadVocab();
  const passing = [];
  const rejected = [];
  for (const s of sentences) {
    const words = extractWords(s);
    if (words.length === 0) {
      rejected.push({ sentence: s, badWords: [], reason: 'empty' });
      continue;
    }
    const badWords = words.filter(w => !isInVocab(w));
    const badRatio = badWords.length / words.length;
    if (badRatio < threshold) {
      passing.push(s);
    } else {
      rejected.push({ sentence: s, badWords, reason: `${badWords.length}/${words.length} oov` });
    }
  }
  return { passing, rejected };
}

/**
 * Get a sample of common base vocabulary for prompt engineering.
 * Returns high-utility words that are definitely in Coglex.
 */
export function getCommonVocabHints(n = 80) {
  if (!_vocab) loadVocab();

  // Take the first N base-category ('w') words — these are open-class content words
  const baseWords = _vocab.tokens
    .filter(([_, cat]) => cat === 'w')
    .map(([token]) => token)
    .slice(0, n);

  return baseWords;
}

/**
 * Stats: breakdown of word categories in a sentence.
 */
export function categorize(sentence) {
  if (!_vocab) loadVocab();
  const catMap = new Map();
  for (const [token, cat] of _vocab.tokens) {
    catMap.set(token.toLowerCase(), cat);
  }

  const words = extractWords(sentence);
  const breakdown = { b: 0, s: 0, c: 0, p: 0, x: 0, i: 0, f: 0, w: 0, unknown: 0 };
  for (const w of words) {
    const cat = catMap.get(w.toLowerCase()) || 'unknown';
    breakdown[cat]++;
  }
  return breakdown;
}
