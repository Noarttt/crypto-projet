import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pumpswapFeePct } from "../src/analysis/fees.js";
import { holderConcentration } from "../src/analysis/holders.js";
import { RateLimiter } from "../src/http.js";
import { parseMigration } from "../src/sources/pumpportal.js";
import { normalizeCandles, idToAddress } from "../src/sources/geckoterminal.js";
import { normalizePair } from "../src/sources/dexscreener.js";
import { Recorder, pickSolanaPairs } from "../src/recorder.js";
import { buildSummary, toMarkdown } from "../src/analysis/summary.js";
import { readConfig } from "../src/config.js";

test("frais PumpSwap par palier de capitalisation", () => {
  assert.equal(pumpswapFeePct(300), 1.25);
  assert.equal(pumpswapFeePct(800), 1.2);
  assert.equal(pumpswapFeePct(5000), 1.0);
  assert.equal(pumpswapFeePct(100000), 0.75);
});

test("concentration : pools et doublons de propriétaire exclus", () => {
  const largest = [
    { address: "vault", uiAmount: 400 },
    { address: "w1a", uiAmount: 50 },
    { address: "w1b", uiAmount: 50 },
    { address: "w2", uiAmount: 20 },
  ];
  const owners = new Map([["vault", "POOL"], ["w1a", "W1"], ["w1b", "W1"], ["w2", "W2"]]);
  const c = holderConcentration({ largest, owners, supply: 1000, excludedOwners: ["POOL"] });
  assert.equal(c.top10_pct, 12);
  assert.equal(c.top1_pct, 10);
  assert.equal(c.pools_pct, 40);
  assert.equal(c.counted_holders, 2);
});

test("limiteur de débit : espacement respecté", async () => {
  let clock = 0;
  const waits = [];
  const lim = new RateLimiter(60, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  const calls = [];
  await Promise.all([1, 2, 3].map((i) => lim.schedule(async () => calls.push([i, clock]))));
  assert.deepEqual(calls, [[1, 0], [2, 1000], [3, 2000]]);
});

test("message de migration PumpPortal", () => {
  assert.deepEqual(parseMigration({ signature: "s", mint: "M", txType: "migrate", pool: "pump-amm" }), { mint: "M", signature: "s", pool: "pump-amm" });
  assert.equal(parseMigration({ message: "Successfully subscribed" }), null);
  assert.equal(parseMigration({ mint: "M", txType: "buy" }), null);
});

test("normalisation GeckoTerminal et DexScreener", () => {
  const c = normalizeCandles([[120, "2", "3", "1", "2.5", "10"], [60, 1, 2, 1, 2, 5]]);
  assert.deepEqual(c.map((k) => k.t), [60, 120]);
  assert.equal(idToAddress("base_0xabc"), "0xabc");
  const p = normalizePair({ pairAddress: "P", dexId: "pumpswap", priceUsd: "0.001", priceNative: "0.000005", liquidity: { usd: 20000 }, marketCap: 100000 });
  assert.equal(Math.round(p.quoteUsd), 200);
});

test("choix des paires PumpSwap et courbe", () => {
  const { swap, curve } = pickSolanaPairs([
    { dexId: "pumpfun", pairAddress: "C" },
    { dexId: "pumpswap", pairAddress: "S1", liquidityUsd: 10 },
    { dexId: "pumpswap", pairAddress: "S2", liquidityUsd: 50 },
    { dexId: "raydium", pairAddress: "R" },
  ]);
  assert.equal(swap.pairAddress, "S2");
  assert.equal(curve.pairAddress, "C");
});

test("enregistreur : cycle complet d'une migration avec sources simulées", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-"));
  const lines = [];
  const journal = { write: (type, rec) => lines.push({ type, ...rec }) };
  let clock = Date.UTC(2026, 9, 21, 12, 0, 0);
  const cfg = readConfig();
  const pair = { pairAddress: "SWAP", dexId: "pumpswap", baseSymbol: "TEST", priceUsd: 0.001, quoteUsd: 200, marketCap: 120000, liquidityUsd: 30000, volume: {}, txns: {}, priceChange: {} };
  const startSec = Math.floor(clock / 1000);
  const candles = Array.from({ length: 170 }, (_, i) => { const p = 0.001 * (1 + i * 0.005); return { t: startSec - 60 + i * 60, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 100 }; });
  const rec = new Recorder({
    ds: { tokenPairs: async () => [pair, { pairAddress: "CURVE", dexId: "pumpfun" }], pairs: async () => [pair] },
    gt: { ohlcv: async () => candles, trades: async () => [], newPools: async () => [] },
    rpc: {
      getTokenLargestAccounts: async () => [{ address: "a1", uiAmount: 100 }],
      getTokenSupply: async () => ({ uiAmount: 1000 }),
      getMultipleParsed: async () => [{ data: { parsed: { info: { owner: "W" } } } }],
      getParsedAccount: async () => ({ owner: "Tok", data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } }),
    },
    journal, getConfig: () => cfg, stateFile: path.join(dir, "state.json"), now: () => clock, log: () => {},
  });
  rec.onSolanaMigration({ mint: "MINT", signature: "SIG" }, {});
  for (let m = 0; m <= 160; m += 1) { clock += 60_000; await rec.tick(); }
  const types = new Set(lines.map((l) => l.type));
  for (const t of ["migration", "pairs", "snapshot", "holders", "curve_trades", "boost_seconds", "outcome"]) assert.ok(types.has(t), `type manquant : ${t}`);
  assert.equal(lines.filter((l) => l.type === "erreur").length, 0, JSON.stringify(lines.filter((l) => l.type === "erreur")));
  const out = lines.find((l) => l.type === "outcome");
  assert.equal(out.result.status, "ok");
  assert.equal(rec.tokens.size, 0);
  rec.save();
  const md = toMarkdown(buildSummary(lines.map((l) => ({ t: "x", ...l }))));
  assert.match(md, /Migrations détectées : 1/);
});
