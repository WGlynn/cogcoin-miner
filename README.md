# cogcoin-miner

CogCoin Proof of Language miner — **Wardenclyffe Cascade**.

Built on [`@cogcoin/scoring`](https://github.com/cogcoin/scoring). Generates sentences via a multi-provider LLM cascade, scores via the canonical 256-scorer blend, persists winners to disk.

## Quick Start

```bash
npm install
export OPENROUTER_API_KEY="sk-or-v1-..."
node src/mine.mjs --demo
```

## Modes

| Command | Description |
|---------|-------------|
| `node src/mine.mjs <domainId> <blockHash>` | Mine a specific block |
| `node src/mine.mjs --demo` | Run against a test block |
| `node src/mine.mjs --grind [dom] [hash] [n]` | Grind `n` rounds on the same block — find best sentence |
| `node src/mine.mjs --watch [domainId]` | Continuous mode: watch Bitcoin, mine each new block |
| `node src/mine.mjs --tip` | Show current Bitcoin tip (via mempool.space) |
| `node src/mine.mjs --stats` | Show mining stats (gate pass rate, best scores, per-block) |

## Provider Cascade

Per-run cascade (never mutates module state):

| Tier | Providers | Cost |
|------|-----------|------|
| 0 | Qwen3 80B, Qwen3 Coder | Free, rate-limited |
| 1 | Llama 4 Scout, Gemini 2.0 Flash, Qwen 3.6 Plus | Cheap, reliable |
| 2 | Claude Haiku 4.5 | Paid, Wardenclyffe escalation |

**Wardenclyffe escalation**: if a Tier 0 provider's gate-pass rate drops below 50%, Claude is promoted to the front of the cascade for remaining batches.

## API Keys

Set at least one:

- `OPENROUTER_API_KEY` — Tier 0/1 (Qwen, Llama, Gemini). Recommended. Free tier: 6M tokens/day.
- `GROQ_API_KEY` — Tier 0 (Llama via Groq, fast, free)
- `ANTHROPIC_API_KEY` — Tier 2 (Claude, escalation)

## Results

Winners persist to `results/mined.json` with:

- Sentence text + canonical blend score
- Hex-encoded 60-byte sentence (for OP_RETURN submission)
- Block hash, domain ID, provider used
- Candidate count, passing count
- Per-block aggregate stats

Atomic writes (via temp file + rename) prevent corruption on crashes.

## Coglex Pre-filter

`src/coglex.mjs` loads the 4,096-token Coglex vocabulary from `@cogcoin/genesis` and provides a soft pre-filter that rejects sentences with majority out-of-vocab words. The WASM encoder in `@cogcoin/scoring` remains canonical — the pre-filter is CPU-only heuristic to catch obvious garbage before the expensive scoring call.

## Retry Logic

All provider calls use `withRetry()` with exponential backoff (1s → 2s → 4s) on:
- `429` rate limits
- `5xx` server errors
- Request timeouts

Auth failures (`401`/`403`) and bad requests (`400`) propagate immediately.

## Block Watcher

`--watch` mode polls public Bitcoin APIs (mempool.space → blockstream.info fallback) every 30s. When a new tip is detected, mines automatically.

## Architecture

```
┌────────────────────────────────────────┐
│  block-watcher.mjs  (poll mempool.space)│
└──────────────┬─────────────────────────┘
               │ new block
               ▼
┌────────────────────────────────────────┐
│  mine.mjs  (Wardenclyffe Cascade)      │
│   ├─ getWords() → 5 BIP-39 mandatory   │
│   ├─ LLM cascade → 60 candidates       │
│   ├─ coglex.mjs preFilter              │
│   ├─ assaySentences() → 256-scorer     │
│   └─ rank by canonicalBlend            │
└──────────────┬─────────────────────────┘
               │ winner
               ▼
┌────────────────────────────────────────┐
│  results/mined.json  (atomic write)    │
└────────────────────────────────────────┘
```

## License

MIT
