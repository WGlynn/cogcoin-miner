/**
 * Tests for coglex.mjs — vocabulary helper.
 *
 * Run with: node --test test/coglex.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getVocabSet,
  isInVocab,
  extractWords,
  preFilterVocab,
  categorize,
  getCommonVocabHints,
} from '../src/coglex.mjs';

test('getVocabSet returns a Set with 4096 entries', () => {
  const vocab = getVocabSet();
  assert.ok(vocab instanceof Set);
  // The Coglex total is 4096; lowercased Set may dedup a few
  assert.ok(vocab.size >= 4000 && vocab.size <= 4096, `vocab size: ${vocab.size}`);
});

test('isInVocab recognizes common BIP-39 words', () => {
  assert.equal(isInVocab('abandon'), true); // BIP-39 word #1
  assert.equal(isInVocab('zoo'), true); // last BIP-39 word
  assert.equal(isInVocab('WRESTLE'), true); // case insensitive
});

test('isInVocab recognizes suffix forms', () => {
  // "wrestle" + "ing" = "wrestling"
  assert.equal(isInVocab('wrestling'), true);
  // "evidence" + "s" = "evidences"
  assert.equal(isInVocab('evidences'), true);
});

test('isInVocab rejects random garbage', () => {
  assert.equal(isInVocab('floozbix'), false);
  assert.equal(isInVocab('qxqxqx'), false);
});

test('isInVocab handles punctuation-only strings', () => {
  // Punctuation-only should return true (deferred to scorer)
  assert.equal(isInVocab('.,!?'), true);
});

test('extractWords splits on whitespace and strips punctuation', () => {
  const words = extractWords('The quick, brown fox.');
  assert.deepEqual(words, ['The', 'quick', 'brown', 'fox']);
});

test('extractWords handles apostrophes', () => {
  const words = extractWords("It's don't won't");
  assert.ok(words.length >= 3);
});

test('preFilterVocab passes clean sentences', () => {
  const sentences = [
    'The evidence will embody the strength of steel.',
    'A double wrestle.',
  ];
  const { passing, rejected } = preFilterVocab(sentences);
  assert.equal(passing.length, 2);
  assert.equal(rejected.length, 0);
});

test('preFilterVocab rejects majority-garbage sentences', () => {
  const sentences = [
    'floozbix qxqxqx zzzzzzz yyyyyyy',  // all garbage
    'The evidence is clear.',  // clean
  ];
  const { passing, rejected } = preFilterVocab(sentences);
  assert.equal(passing.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(passing[0], 'The evidence is clear.');
});

test('preFilterVocab respects threshold', () => {
  // With threshold 0.1, even one bad word triggers rejection
  const sentences = ['The floozbix evidence.'];
  const strict = preFilterVocab(sentences, 0.1);
  assert.equal(strict.passing.length, 0);
  assert.equal(strict.rejected.length, 1);

  // With threshold 0.5 (default), minority bad words pass
  const loose = preFilterVocab(sentences);
  assert.equal(loose.passing.length, 1);
});

test('categorize returns category breakdown', () => {
  const breakdown = categorize('The evidence will embody steel.');
  assert.ok(typeof breakdown === 'object');
  // "evidence" is a bip39 word
  assert.ok(breakdown.b > 0, 'should have bip39 words');
});

test('getCommonVocabHints returns real Coglex base words', () => {
  const hints = getCommonVocabHints(20);
  assert.equal(hints.length, 20);
  // All should be in vocab
  for (const word of hints) {
    assert.equal(isInVocab(word), true, `hint '${word}' should be in vocab`);
  }
});
