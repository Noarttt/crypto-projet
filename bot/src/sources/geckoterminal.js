// GeckoTerminal (API publique sans clé, ~10 appels/min) : nouveaux pools, bougies OHLCV, derniers trades.
import { fetchJson, HttpError } from "../http.js";

const BASE = "https://api.geckoterminal.com/api/v2";
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// "base_0xabc…" -> "0xabc…"
export const idToAddress = (id) => (typeof id === "string" && id.includes("_") ? id.slice(id.indexOf("_") + 1) : id ?? null);

export function normalizeCandles(list) {
  return (Array.isArray(list) ? list : [])
    .map(([t, o, h, l, c, v]) => ({ t: Number(t), o: num(o), h: num(h), l: num(l), c: num(c), v: num(v) }))
    .filter((k) => Number.isFinite(k.t) && k.o !== null && k.h !== null && k.l !== null && k.c !== null)
    .sort((a, b) => a.t - b.t);
}

export function normalizePool(d) {
  const a = d?.attributes ?? {};
  const r = d?.relationships ?? {};
  return {
    address: a.address ?? idToAddress(d?.id),
    name: a.name ?? null,
    dexId: r.dex?.data?.id ?? null,
    baseToken: idToAddress(r.base_token?.data?.id),
    quoteToken: idToAddress(r.quote_token?.data?.id),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    priceUsd: num(a.base_token_price_usd),
    reserveUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd),
    mcapUsd: num(a.market_cap_usd),
    volume: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h24: num(a.volume_usd?.h24) },
    tx: {
      m5: { buys: num(a.transactions?.m5?.buys), sells: num(a.transactions?.m5?.sells), buyers: num(a.transactions?.m5?.buyers), sellers: num(a.transactions?.m5?.sellers) },
    },
  };
}

export function normalizeTrades(data) {
  return (Array.isArray(data) ? data : []).map((d) => {
    const a = d.attributes ?? {};
    return {
      ts: a.block_timestamp ? Date.parse(a.block_timestamp) : null,
      kind: a.kind,
      wallet: a.tx_from_address ?? null,
      usd: num(a.volume_in_usd),
      tx: a.tx_hash ?? null,
    };
  });
}

export function createGeckoTerminal(limiter) {
  const get = (p) => fetchJson(`${BASE}${p}`, { limiter, retries: 2 });
  return {
    async newPools(network, page = 1) {
      const data = await get(`/networks/${network}/new_pools?page=${page}&include=base_token,quote_token,dex`);
      const quoteSymbols = new Map();
      for (const inc of data?.included ?? []) {
        if (inc.type === "token") quoteSymbols.set(idToAddress(inc.id)?.toLowerCase(), inc.attributes?.symbol ?? null);
      }
      return (data?.data ?? []).map((d) => {
        const p = normalizePool(d);
        p.quoteSymbol = quoteSymbols.get(p.quoteToken?.toLowerCase()) ?? null;
        p.baseSymbol = quoteSymbols.get(p.baseToken?.toLowerCase()) ?? null;
        return p;
      });
    },
    // Bougies triées dans l'ordre chronologique. timeframe : "second" | "minute" | "hour".
    async ohlcv(network, pool, { timeframe = "minute", aggregate = 1, limit = 200, beforeTs } = {}) {
      const q = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit), currency: "usd", token: "base", include_empty_intervals: "true" });
      if (beforeTs) q.set("before_timestamp", String(Math.floor(beforeTs)));
      try {
        const data = await get(`/networks/${network}/pools/${pool}/ohlcv/${timeframe}?${q}`);
        return normalizeCandles(data?.data?.attributes?.ohlcv_list);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    // 300 derniers trades (24 h) d'un pool.
    async trades(network, pool) {
      try {
        const data = await get(`/networks/${network}/pools/${pool}/trades`);
        return normalizeTrades(data?.data);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
  };
}
