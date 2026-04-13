/**
 * CogCoin Proof of Language Miner — Wardenclyffe Cascade v4
 *
 * Generates optimized sentences via multi-provider LLM cascade,
 * scores them locally via @cogcoin/scoring, persists winners to disk.
 *
 * Cascade (per-run, never mutated):
 *   Tier 0: Qwen free models — zero cost, rate-limited
 *   Tier 1: Llama 4 Scout, Gemini Flash, Qwen Plus — cheap, reliable
 *   Tier 2: Claude — paid escalation if T0 gate-pass rate < 50%
 *
 * Modes:
 *   node src/mine.mjs <domainId> <blockHash>    Single block
 *   node src/mine.mjs --demo                    Test block
 *   node src/mine.mjs --grind [dom] [hash] [n]  Grind n rounds
 *   node src/mine.mjs --stats                   Show mining stats
 *
 * Results persist to results/mined.json — banked for submission
 * when domain registration is complete.
 */

import { getWords, assaySentences } from '@cogcoin/scoring';
import { preFilterVocab } from './coglex.mjs';
import { getBitcoinTip, watchBlocks } from './block-watcher.mjs';

// ============ Config ============

const CANDIDATES_PER_BATCH = 20;
const BATCHES = 3;

// ============ Wardenclyffe Provider Cascade ============

const PROVIDERS = {
  // Tier 0 — Free
  qwen_free: {
    name: 'Qwen3 80B (free)',
    tier: 0,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3-next-80b-a3b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    }),
  },
  qwen_coder: {
    name: 'Qwen3 Coder (free)',
    tier: 0,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3-coder:free',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    }),
  },
  // Tier 1 — Cheap, fast, reliable
  llama4_scout: {
    name: 'Llama 4 Scout',
    tier: 1,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-4-scout',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    }),
  },
  gemini_flash: {
    name: 'Gemini 2.0 Flash',
    tier: 1,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.0-flash-001',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    }),
  },
  // Tier 1.5 — Near-free but currently unreliable
  qwen_plus: {
    name: 'Qwen 3.6 Plus',
    tier: 1,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3.6-plus',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vibeswap.org',
    }),
  },
  groq: {
    name: 'Groq Llama',
    tier: 0,
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    }),
  },
  // Tier 2 — Paid (escalation)
  claude: {
    name: 'Claude Haiku',
    tier: 2,
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5-20251001',
    keyEnv: 'ANTHROPIC_API_KEY',
    anthropic: true,
  },
};

// Cascade order: Gemini Flash leads based on empirical benchmark (bench.mjs).
// On Bitcoin tip 944950, Gemini: 67% gate-pass / 489M top score. Llama: 0%.
const DEFAULT_CASCADE = ['gemini_flash', 'llama4_scout', 'qwen_free', 'qwen_coder', 'groq', 'qwen_plus', 'claude'];

// ============ Prompt ============

const SYSTEM_PROMPT = `You are a sentence generation engine for CogCoin Proof of Language mining.

RULES (MANDATORY — violations = zero score):
1. Use ALL 5 provided words exactly as given (inflections like plurals/tenses ARE allowed)
2. End with . or ? or !
3. Produce grammatically correct, natural English
4. Each sentence should be unique and creative
5. Keep sentences concise (10-20 words ideal) — the Coglex vocabulary is 4,096 tokens
6. Use common English words — rare/technical words may not be in the Coglex vocabulary
7. Prefer simple sentence structures that read naturally

SCORING STRATEGY (higher blend score wins):
- Natural fluency and readability score well
- Good grammar and clear sentence structure
- Varied vocabulary within common English
- Meaningful semantic content (not just stringing words together)
- Declarative sentences with periods tend to score slightly higher

OUTPUT: Return ONLY the sentences, one per line. No numbering, no explanations.`;

function buildUserPrompt(words, count) {
  return `Generate exactly ${count} unique English sentences using ALL of these 5 words: ${words.join(', ')}

Each sentence must:
- Include all 5 words (inflected forms OK)
- End with . or ? or !
- Be grammatically perfect
- Use common vocabulary (avoid jargon)
- Be 10-20 words long

${count} sentences, one per line:`;
}

// ============ Provider Calls ============

async function withRetry(fn, { retries = 2, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Only retry on rate limits or transient errors — not auth/bad-request
      const msg = err.message || '';
      const is429 = msg.startsWith('429');
      const is5xx = /^5\d\d/.test(msg);
      const isTimeout = msg.includes('aborted') || msg.includes('timeout');
      const retryable = is429 || is5xx || isTimeout;

      if (!retryable || attempt === retries) throw err;

      // Exponential backoff: 1s, 2s, 4s...
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function callOpenAICompatible(provider, words, count) {
  const key = process.env[provider.keyEnv];
  if (!key) return null;

  return withRetry(async () => {
    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: provider.headers(key),
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(words, count) },
        ],
        max_tokens: 2000,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${resp.status} ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  });
}

async function callAnthropic(provider, words, count) {
  const key = process.env[provider.keyEnv];
  if (!key) return null;

  return withRetry(async () => {
    const resp = await fetch(`${provider.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(words, count) }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${resp.status} ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.content?.[0]?.text || '';
  });
}

async function callProvider(providerId, words, count) {
  const provider = PROVIDERS[providerId];
  if (provider.anthropic) {
    return callAnthropic(provider, words, count);
  }
  return callOpenAICompatible(provider, words, count);
}

function parseResponse(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && /[.?!]$/.test(line))
    .map(line => line.replace(/^\d+[\.\)]\s*/, ''));
}

// ============ Cascade Logic ============

async function generateWithCascade(words, count, cascadeOrder) {
  for (const providerId of cascadeOrder) {
    const provider = PROVIDERS[providerId];
    const key = process.env[provider.keyEnv];

    if (!key) {
      continue; // skip providers without keys
    }

    try {
      process.stdout.write(`  [T${provider.tier}] ${provider.name}...`);
      const text = await callProvider(providerId, words, count);
      const sentences = parseResponse(text);
      console.log(` ${sentences.length} sentences`);

      if (sentences.length > 0) {
        return { providerId, sentences };
      }
    } catch (err) {
      console.log(` FAIL: ${err.message.slice(0, 100)}`);
    }
  }

  return { providerId: null, sentences: [] };
}

// ============ Result Persistence ============

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');
const RESULTS_FILE = join(RESULTS_DIR, 'mined.json');

function loadResults() {
  try {
    if (existsSync(RESULTS_FILE)) {
      return JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
    }
  } catch {}
  return {
    winners: [],
    stats: { totalRuns: 0, totalCandidates: 0, totalPassing: 0 },
    perBlock: {}, // blockHash → { runs, bestScore, bestSentence, gatePassRate }
  };
}

// Atomic write: write to .tmp, then rename. Prevents partial-write corruption
// if the process dies mid-write (e.g., API Death Shield scenario).
function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function saveResult(winner, meta) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const data = loadResults();

  const scoreStr = winner.canonicalBlend?.toString() || '0';
  const scoreBig = BigInt(scoreStr);

  data.winners.push({
    timestamp: new Date().toISOString(),
    blockHash: meta.blockHash,
    domainId: meta.domainId,
    sentence: winner.sentence,
    score: scoreStr,
    encoded: Buffer.from(winner.encodedSentenceBytes).toString('hex'),
    provider: meta.provider,
    escalated: meta.escalated,
    candidates: meta.candidates,
    passing: meta.passing,
  });
  data.stats.totalRuns++;
  data.stats.totalCandidates += meta.candidates;
  data.stats.totalPassing += meta.passing;

  // Per-block stats
  if (!data.perBlock) data.perBlock = {};
  const key = `${meta.domainId}:${meta.blockHash.slice(0, 16)}`;
  const existing = data.perBlock[key] || { runs: 0, bestScore: '0', totalCandidates: 0, totalPassing: 0 };
  existing.runs++;
  existing.totalCandidates += meta.candidates;
  existing.totalPassing += meta.passing;
  if (scoreBig > BigInt(existing.bestScore)) {
    existing.bestScore = scoreStr;
    existing.bestSentence = winner.sentence;
  }
  data.perBlock[key] = existing;

  atomicWrite(RESULTS_FILE, JSON.stringify(data, null, 2));
}

// ============ Mining Loop ============

async function mine(domainId, blockHash) {
  console.log(`\n=== CogCoin PoL Miner (Wardenclyffe Cascade) ===`);
  console.log(`Domain: ${domainId} | Block: ${blockHash.slice(0, 16)}...`);

  // Per-run cascade copy (never mutate module-level DEFAULT_CASCADE)
  let cascadeOrder = [...DEFAULT_CASCADE];

  // Show available providers
  const available = cascadeOrder.filter(id => process.env[PROVIDERS[id].keyEnv]);
  const missing = cascadeOrder.filter(id => !process.env[PROVIDERS[id].keyEnv]);
  console.log(`Providers: ${available.map(id => `${PROVIDERS[id].name}[T${PROVIDERS[id].tier}]`).join(' → ') || 'NONE'}`);
  if (missing.length > 0) {
    console.log(`Inactive: ${missing.map(id => `${id}(${PROVIDERS[id].keyEnv})`).join(', ')}`);
  }

  if (available.length === 0) {
    console.error('\nNo API keys set. Need at least one of:');
    console.error('  OPENROUTER_API_KEY  (free — Qwen, recommended)');
    console.error('  GROQ_API_KEY        (free — Groq)');
    console.error('  ANTHROPIC_API_KEY   (paid — Claude)');
    process.exit(1);
  }

  const words = getWords(domainId, blockHash);
  console.log(`Words: ${words.join(', ')}\n`);

  let allCandidates = [];
  let usedProvider = null;
  let escalated = false;

  for (let batch = 0; batch < BATCHES; batch++) {
    console.log(`Batch ${batch + 1}/${BATCHES}:`);
    const { providerId, sentences } = await generateWithCascade(words, CANDIDATES_PER_BATCH, cascadeOrder);

    if (providerId) {
      usedProvider = providerId;
    }
    allCandidates.push(...sentences);

    // Wardenclyffe escalation check after first batch:
    // If gate-pass rate < 50% on a T0 provider, escalate to T2
    if (batch === 0 && sentences.length > 0 && PROVIDERS[usedProvider]?.tier === 0) {
      const quickAssay = await assaySentences(domainId, blockHash, sentences.slice(0, 5));
      const passRate = quickAssay.filter(r => r.gatesPass).length / quickAssay.length;
      if (passRate < 0.5) {
        console.log(`  ⚠ Gate-pass rate ${(passRate * 100).toFixed(0)}% — escalating to T2`);
        // Move Claude to front of per-run cascade (not module-level)
        const claudeIdx = cascadeOrder.indexOf('claude');
        if (claudeIdx > 0 && process.env[PROVIDERS.claude.keyEnv]) {
          cascadeOrder = ['claude', ...cascadeOrder.filter(id => id !== 'claude')];
          escalated = true;
        }
      }
    }
  }

  console.log(`\nTotal candidates: ${allCandidates.length}`);
  if (allCandidates.length === 0) {
    console.error('No candidates generated.');
    return null;
  }

  allCandidates = [...new Set(allCandidates)];
  console.log(`After dedup: ${allCandidates.length}`);

  // Coglex pre-filter: reject sentences with obviously-out-of-vocab words
  // before expensive 256-scorer blend. Cheap CPU filter.
  const { passing: vocabOk, rejected: vocabRejected } = preFilterVocab(allCandidates);
  console.log(`After Coglex pre-filter: ${vocabOk.length} (rejected ${vocabRejected.length} for out-of-vocab words)`);
  if (vocabOk.length === 0) {
    console.error('No candidates survived Coglex pre-filter.');
    return null;
  }
  allCandidates = vocabOk;

  console.log('Scoring via 256-scorer blend...\n');
  const results = await assaySentences(domainId, blockHash, allCandidates);

  const passing = results.filter(r => r.gatesPass);
  const failing = results.filter(r => !r.gatesPass);

  console.log(`Gates passed: ${passing.length}/${results.length}`);

  if (failing.length > 0) {
    const failureCodes = new Set();
    for (const f of failing) {
      for (const d of (f.failureDetails || [])) {
        failureCodes.add(d.code);
      }
    }
    console.log(`Failure reasons: ${[...failureCodes].join(', ')}`);
  }

  if (passing.length === 0) {
    console.error('\nNo sentences passed gates. Try again.');
    return null;
  }

  passing.sort((a, b) => {
    const scoreA = BigInt(a.canonicalBlend || 0);
    const scoreB = BigInt(b.canonicalBlend || 0);
    if (scoreB > scoreA) return 1;
    if (scoreA > scoreB) return -1;
    return 0;
  });

  console.log('\n=== TOP 10 CANDIDATES ===\n');
  const top = passing.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const score = BigInt(r.canonicalBlend || 0);
    const bar = '█'.repeat(Number(score / 10000000n));
    console.log(`#${i + 1} [${score}] ${bar}`);
    console.log(`   ${r.sentence}\n`);
  }

  const winner = passing[0];
  console.log('=== WINNER ===');
  console.log(`Provider: ${PROVIDERS[usedProvider]?.name || 'unknown'}${escalated ? ' (escalated)' : ''}`);
  console.log(`Score: ${winner.canonicalBlend}`);
  console.log(`Sentence: ${winner.sentence}`);
  console.log(`Encoded: ${Buffer.from(winner.encodedSentenceBytes).toString('hex')}`);

  // Persist result
  saveResult(winner, {
    blockHash,
    domainId,
    provider: PROVIDERS[usedProvider]?.name || 'unknown',
    escalated,
    candidates: allCandidates.length,
    passing: passing.length,
  });
  console.log(`\nResult saved to ${RESULTS_FILE}`);

  return winner;
}

// ============ Stats ============

function showStats() {
  const data = loadResults();
  const { winners, stats } = data;
  console.log('\n=== Mining Stats ===');
  console.log(`Total runs: ${stats.totalRuns}`);
  console.log(`Total candidates: ${stats.totalCandidates}`);
  console.log(`Total passing: ${stats.totalPassing}`);
  console.log(`Gate pass rate: ${stats.totalCandidates > 0 ? ((stats.totalPassing / stats.totalCandidates) * 100).toFixed(1) : 0}%`);
  if (winners.length > 0) {
    const scores = winners.map(w => BigInt(w.score));
    const best = scores.reduce((a, b) => a > b ? a : b);
    console.log(`Best score: ${best}`);
    console.log(`Total winners banked: ${winners.length}`);
    console.log(`\nLast 5 winners:`);
    for (const w of winners.slice(-5)) {
      console.log(`  [${w.score}] ${w.sentence.slice(0, 60)}...`);
    }
  }
}

// ============ CLI ============

const args = process.argv.slice(2);

if (args[0] === '--demo') {
  await mine(1, '0000000000000000000000000000000000000000000000000000000000000001');
} else if (args[0] === '--stats') {
  showStats();
} else if (args[0] === '--grind') {
  // Grind mode: mine the same block repeatedly to find the best sentence
  const domainId = parseInt(args[1] || '1');
  const blockHash = args[2] || '0000000000000000000000000000000000000000000000000000000000000001';
  const rounds = parseInt(args[3] || '10');
  console.log(`\n=== GRIND MODE: ${rounds} rounds ===\n`);
  let bestScore = 0n;
  let bestSentence = '';
  for (let i = 0; i < rounds; i++) {
    console.log(`\n--- Round ${i + 1}/${rounds} ---`);
    const winner = await mine(domainId, blockHash);
    if (winner) {
      const score = BigInt(winner.canonicalBlend || 0);
      if (score > bestScore) {
        bestScore = score;
        bestSentence = winner.sentence;
        console.log(`\n★ NEW BEST: [${bestScore}] ${bestSentence}`);
      }
    }
  }
  console.log(`\n=== GRIND COMPLETE ===`);
  console.log(`Best score: ${bestScore}`);
  console.log(`Best sentence: ${bestSentence}`);
  showStats();
} else if (args[0] === '--tip') {
  // Show current Bitcoin tip (useful for testing)
  try {
    const tip = await getBitcoinTip();
    console.log(`Bitcoin tip: ${tip.hash}`);
    console.log(`Height: ${tip.height}`);
    console.log(`Source: ${tip.source}`);
  } catch (err) {
    console.error(`Failed to get tip: ${err.message}`);
    process.exit(1);
  }
} else if (args[0] === '--watch') {
  // Continuous mining: watch Bitcoin blocks, mine each new one
  const domainId = parseInt(args[1] || '1');
  console.log(`\n=== WATCH MODE: mining each new Bitcoin block for domain ${domainId} ===\n`);

  let blocksMined = 0;
  const stop = watchBlocks(async (tip) => {
    blocksMined++;
    console.log(`\n[${new Date().toISOString()}] New block detected: ${tip.hash.slice(0, 16)}... (height ${tip.height})`);
    try {
      await mine(domainId, tip.hash);
    } catch (err) {
      console.error(`Mining error: ${err.message}`);
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log(`\nShutting down. Mined ${blocksMined} blocks this session.`);
    stop();
    showStats();
    process.exit(0);
  });
} else if (args.length >= 2) {
  const domainId = parseInt(args[0]);
  const blockHash = args[1];
  await mine(domainId, blockHash);
} else {
  console.log('CogCoin PoL Miner — Wardenclyffe Cascade v4');
  console.log('');
  console.log('Usage:');
  console.log('  node src/mine.mjs <domainId> <blockHash>   Mine a specific block');
  console.log('  node src/mine.mjs --demo                   Demo with test block');
  console.log('  node src/mine.mjs --grind [dom] [hash] [n] Grind n rounds on same block');
  console.log('  node src/mine.mjs --watch [domainId]       Watch Bitcoin, mine each new block');
  console.log('  node src/mine.mjs --tip                    Show current Bitcoin tip');
  console.log('  node src/mine.mjs --stats                  Show mining stats');
  console.log('');
  console.log('API Keys (set at least one):');
  console.log('  OPENROUTER_API_KEY  Tier 0/1 — Qwen, Llama, Gemini (recommended)');
  console.log('  GROQ_API_KEY        Tier 0 — Groq Llama (free, fast)');
  console.log('  ANTHROPIC_API_KEY   Tier 2 — Claude (paid, escalation)');
  console.log('');
  console.log('Results persist to results/mined.json');
}
