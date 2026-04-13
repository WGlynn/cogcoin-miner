/**
 * Tests for block-watcher.mjs — Bitcoin tip fetcher.
 *
 * Run with: node --test test/block-watcher.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBitcoinTip } from '../src/block-watcher.mjs';

test('getBitcoinTip returns a valid tip', async () => {
  const tip = await getBitcoinTip();
  assert.ok(tip.hash, 'tip should have a hash');
  assert.equal(typeof tip.hash, 'string');
  assert.match(tip.hash, /^[0-9a-f]{64}$/, 'hash should be 64 hex chars');
  assert.ok(tip.height > 900000, `height should be > 900k (current chain), got ${tip.height}`);
  assert.ok(tip.source, 'source should be named');
});
