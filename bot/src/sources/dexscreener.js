// DexScreener : prix, liquidité, volume et transactions des paires (API gratuite, sans clé).
import { fetchJson } from "../http.js";

const BASE = "https://api.dexscreener.com";
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function normalizePair(p) {
  if (!p) return null;
  const priceUsd = num(p.priceUsd);
  const priceNative = num(p.priceNative);
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    baseAddress: p.baseToken?.address ?? null,
    baseSymbol: p.baseToken?.symbol ?? null,
    quoteAddress: p.quoteToken?.address ?? null,
    quoteSymbol: p.quoteToken?.symbol ?? null,
    priceUsd,
    priceNative,
    // Prix de la devise de cotation (ex. SOL) en USD, déduit du couple priceUsd / priceNative.
    quoteUsd: priceUsd && priceNative ? priceUsd / priceNative : null,
    liquidityUsd: num(p.liquidity?.usd),
    liquidityQuote: num(p.liquidity?.quote),
    marketCap: num(p.marketCap),
    fdv: num(p.fdv),
    volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
    txns: {
      m5: { buys: num(p.txns?.m5?.buys), sells: num(p.txns?.m5?.sells) },
      h1: { buys: num(p.txns?.h1?.buys), sells: num(p.txns?.h1?.sells) },
    },
    priceChange: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1) },
    pairCreatedAt: num(p.pairCreatedAt),
  };
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function createDexScreener(limiter) {
  return {
    // Toutes les paires d'un jeton sur une chaîne.
    async tokenPairs(chain, token) {
      const data = await fetchJson(`${BASE}/token-pairs/v1/${chain}/${token}`, { limiter });
      return (Array.isArray(data) ? data : []).map(normalizePair);
    },
    // Paires par adresse de paire, par lots de 30.
    async pairs(chain, pairAddresses) {
      const out = [];
      for (const group of chunks([...new Set(pairAddresses)], 30)) {
        const data = await fetchJson(`${BASE}/latest/dex/pairs/${chain}/${group.join(",")}`, { limiter });
        const list = data?.pairs ?? (data?.pair ? [data.pair] : []);
        for (const p of list) out.push(normalizePair(p));
      }
      return out;
    },
  };
}
