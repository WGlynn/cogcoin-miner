/**
 * Provider benchmark: run each available LLM on the same block,
 * compare gate-pass rate, top scores, latency.
 *
 * Output: JSON summary for sharing/analysis.
 *
 * Usage:
 *   node src/bench.mjs [domainId] [blockHash] [candidatesPerProvider]
 */

import { getWords, assaySentences } from '@cogcoin/scoring';
import { preFilterVocab } from './coglex.mjs';
import { getBitcoinTip } from './block-watcher.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');

// ============ Providers ============

const PROVIDERS = {
  llama4_scout: {
    name: 'Llama 4 Scout',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-4-scout',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  gemini_flash: {
    name: 'Gemini 2.0 Flash',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.0-flash-001',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  qwen_plus: {
    name: 'Qwen 3.6 Plus',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3.6-plus',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  qwen_coder: {
    name: 'Qwen3 Coder (free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3-coder:free',
    keyEnv: 'OPENROUTER_API_KEY',
  },
};

const SYSTEM_PROMPT = `You are a sentence generation engine for CogCoin Proof of Language mining.

RULES (MANDATORY):
1. Use ALL 5 provided words exactly as given (inflections OK)
2. End with . or ? or !
3. Natural English, 10-20 words
4. Use common vocabulary (Coglex has 4,096 tokens)

OUTPUT: Return ONLY the sentences, one per line.`;

async function callProvider(provider, words, count) {
  const key = process.env[provider.keyEnv];
  if (!key) throw new Error('no key');

  const start = Date.now();
  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Generate ${count} unique sentences using: ${words.join(', ')}` },
      ],
      max_tokens: 2000,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(60000),
  });

  const latencyMs = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${body.slice(0, 100)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  const sentences = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && /[.?!]$/.test(l))
    .map(l => l.replace(/^\d+[\.\)]\s*/, ''));

  return { sentences, latencyMs };
}

async function benchProvider(providerId, words, domainId, blockHash, count) {
  const provider = PROVIDERS[providerId];
  const key = process.env[provider.keyEnv];
  if (!key) return { providerId, name: provider.name, skipped: 'no key' };

  console.log(`\n[${provider.name}] Generating ${count} candidates...`);
  try {
    const { sentences, latencyMs } = await callProvider(provider, words, count);
    console.log(`  Generated: ${sentences.length} in ${latencyMs}ms`);

    if (sentences.length === 0) {
      return { providerId, name: provider.name, error: 'zero sentences' };
    }

    const { passing: vocabOk } = preFilterVocab(sentences);
    console.log(`  Coglex pre-filter: ${vocabOk.length}/${sentences.length} passed`);

    if (vocabOk.length === 0) {
      return { providerId, name: provider.name, latencyMs, generated: sentences.length, passing: 0 };
    }

    const results = await assaySentences(domainId, blockHash, vocabOk);
    const passing = results.filter(r => r.gatesPass);

    let topScore = 0n;
    let topSentence = '';
    for (const r of passing) {
      const score = BigInt(r.canonicalBlend || 0);
      if (score > topScore) {
        topScore = score;
        topSentence = r.sentence;
      }
    }

    console.log(`  Gate-pass: ${passing.length}/${vocabOk.length}`);
    console.log(`  Top score: ${topScore}`);

    return {
      providerId,
      name: provider.name,
      latencyMs,
      generated: sentences.length,
      preFilterPassed: vocabOk.length,
      gatePassed: passing.length,
      gatePassRate: (passing.length / vocabOk.length),
      topScore: topScore.toString(),
      topSentence,
    };
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
    return { providerId, name: provider.name, error: err.message.slice(0, 100) };
  }
}

// ============ Main ============

const args = process.argv.slice(2);
const candidatesPerProvider = parseInt(args[2] || '30');

let domainId, blockHash;
if (args.length >= 2) {
  domainId = parseInt(args[0]);
  blockHash = args[1];
} else {
  console.log('Fetching current Bitcoin tip...');
  const tip = await getBitcoinTip();
  console.log(`Tip: ${tip.hash} (height ${tip.height})`);
  domainId = parseInt(args[0] || '1');
  blockHash = tip.hash;
}

const words = getWords(domainId, blockHash);

console.log('\n=== CogCoin Miner Provider Benchmark ===');
console.log(`Domain: ${domainId} | Block: ${blockHash.slice(0, 16)}...`);
console.log(`Words: ${words.join(', ')}`);
console.log(`Candidates per provider: ${candidatesPerProvider}`);

const results = [];
for (const providerId of Object.keys(PROVIDERS)) {
  const result = await benchProvider(providerId, words, domainId, blockHash, candidatesPerProvider);
  results.push(result);
}

console.log('\n=== BENCHMARK SUMMARY ===\n');
const sorted = results
  .filter(r => r.topScore)
  .sort((a, b) => {
    const sa = BigInt(a.topScore || 0);
    const sb = BigInt(b.topScore || 0);
    return sb > sa ? 1 : sa > sb ? -1 : 0;
  });

for (const r of sorted) {
  console.log(`${r.name.padEnd(20)} top=${r.topScore.padStart(12)} gate=${(r.gatePassRate * 100).toFixed(0)}% gen=${r.generated} lat=${r.latencyMs}ms`);
  console.log(`  "${r.topSentence}"`);
}

// Save to results dir
mkdirSync(RESULTS_DIR, { recursive: true });
const benchFile = join(RESULTS_DIR, `bench-${Date.now()}.json`);
writeFileSync(benchFile, JSON.stringify({
  timestamp: new Date().toISOString(),
  domainId,
  blockHash,
  words,
  candidatesPerProvider,
  results,
}, null, 2));
console.log(`\nSaved to ${benchFile}`);
