/**
 * Bitcoin block watcher — polls public APIs for latest blocks.
 *
 * Used by the miner's --watch mode to know when to mine a new block.
 * Uses mempool.space as primary, blockstream.info as fallback.
 *
 * CogCoin mining references Bitcoin block H-1 for its blend seed
 * and BIP-39 word assignment, so watching the Bitcoin chain is
 * how we know when to mine a new CogCoin block.
 */

const APIS = [
  {
    name: 'mempool.space',
    tipUrl: 'https://mempool.space/api/blocks/tip/hash',
    heightUrl: 'https://mempool.space/api/blocks/tip/height',
  },
  {
    name: 'blockstream.info',
    tipUrl: 'https://blockstream.info/api/blocks/tip/hash',
    heightUrl: 'https://blockstream.info/api/blocks/tip/height',
  },
];

async function fetchText(url, timeoutMs = 10000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return (await resp.text()).trim();
}

/**
 * Get the current Bitcoin tip block hash + height.
 * Tries APIs in order, returns first successful response.
 */
export async function getBitcoinTip() {
  for (const api of APIS) {
    try {
      const [hash, height] = await Promise.all([
        fetchText(api.tipUrl),
        fetchText(api.heightUrl),
      ]);
      return {
        hash,
        height: parseInt(height, 10),
        source: api.name,
      };
    } catch (err) {
      // Try next API
      continue;
    }
  }
  throw new Error('All Bitcoin APIs failed');
}

/**
 * Watch for new Bitcoin blocks.
 *
 * Calls onNewBlock(tip) when a new tip is detected.
 * Polls every pollIntervalMs (default 30s — Bitcoin blocks are ~10min).
 * Returns a stop() function.
 */
export function watchBlocks(onNewBlock, { pollIntervalMs = 30000 } = {}) {
  let lastHash = null;
  let running = true;

  async function poll() {
    if (!running) return;
    try {
      const tip = await getBitcoinTip();
      if (tip.hash !== lastHash) {
        lastHash = tip.hash;
        await onNewBlock(tip);
      }
    } catch (err) {
      console.error(`Block watcher error: ${err.message}`);
    }

    if (running) {
      setTimeout(poll, pollIntervalMs);
    }
  }

  // Start immediately
  poll();

  return () => { running = false; };
}
