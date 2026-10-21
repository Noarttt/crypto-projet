// Enregistreur de la phase 1 : suit chaque migration Solana et chaque nouveau pool Base,
// prend des instantanés planifiés, puis calcule le résultat une fois la fenêtre d'observation passée.
// Aucun ordre d'achat ou de vente n'est jamais envoyé.
import fs from "node:fs";
import path from "node:path";
import { holderConcentration } from "./analysis/holders.js";
import { curveTradeMetrics } from "./analysis/outcome.js";
import { analyzeTrajectory, solanaFeeFactory, baseFeeFactory, curveMetrics } from "./analysis/report.js";

const MIN = 60_000;
const isPumpSwap = (dexId) => /pump-?swap|pump-?amm/i.test(dexId ?? "");
const isPumpCurve = (dexId) => /^pump-?fun$/i.test(dexId ?? "");

export function pickSolanaPairs(pairs) {
  const swap = pairs.filter((p) => p && isPumpSwap(p.dexId)).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null;
  const curve = pairs.find((p) => p && isPumpCurve(p.dexId)) ?? null;
  return { swap, curve };
}

export class Recorder {
  constructor({ ds, gt, rpc, journal, getConfig, stateFile, now = () => Date.now(), log = console.log }) {
    Object.assign(this, { ds, gt, rpc, journal, getConfig, stateFile, now, log });
    this.tokens = new Map(); // id -> état du suivi
    this.seenBase = new Set();
    this.busy = new Set();
    this.stats = { solana_detected: 0, base_detected: 0, outcomes: 0, errors: 0 };
    this.load();
  }

  // ---------- persistance ----------
  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      for (const t of s.tokens ?? []) this.tokens.set(t.id, t);
      for (const p of s.seenBase ?? []) this.seenBase.add(p);
      this.log(`[état] ${this.tokens.size} jetons en cours de suivi repris`);
    } catch { /* premier démarrage */ }
  }
  save() {
    const seen = [...this.seenBase].slice(-5000);
    const tmp = this.stateFile + ".tmp";
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ tokens: [...this.tokens.values()], seenBase: seen }));
    fs.renameSync(tmp, this.stateFile);
  }

  // ---------- entrées ----------
  onSolanaMigration(m, raw) {
    const cfg = this.getConfig();
    if (cfg.paused || !cfg.solana?.enabled) return;
    const id = `sol:${m.mint}`;
    if (this.tokens.has(id)) return;
    const t = {
      id, chain: "solana", mint: m.mint, detectedAt: this.now(), signature: m.signature,
      swapPair: null, curvePair: null, discoverTries: 0,
      snapsDone: [], holdersDone: [], curveTradesDone: false, boostSecondsDone: false,
      mcapSolAtStart: null, quoteUsdAtStart: null,
    };
    this.tokens.set(id, t);
    this.stats.solana_detected += 1;
    this.journal.write("migration", { chain: "solana", mint: m.mint, signature: m.signature, pool_hint: m.pool, raw_keys: Object.keys(raw ?? {}) });
  }

  async pollBase() {
    const cfg = this.getConfig();
    if (cfg.paused || !cfg.base?.enabled) return;
    const pools = await this.gt.newPools("base", 1);
    const quotes = new Set((cfg.base.quote_symbols ?? []).map((s) => s.toUpperCase()));
    for (const p of pools) {
      if (!p.address || this.seenBase.has(p.address)) continue;
      this.seenBase.add(p.address);
      if (p.quoteSymbol && quotes.size && !quotes.has(p.quoteSymbol.toUpperCase())) continue;
      const createdAt = p.createdAt ?? this.now();
      if (this.now() - createdAt > 30 * MIN) continue; // trop ancien pour être suivi depuis le lancement
      const id = `base:${p.address}`;
      this.tokens.set(id, {
        id, chain: "base", pool: p.address, token: p.baseToken, symbol: p.baseSymbol, quote: p.quoteSymbol, dexId: p.dexId,
        detectedAt: createdAt, snapsDone: [], lastSnap: null,
      });
      this.stats.base_detected += 1;
      this.journal.write("base_pool", { chain: "base", pool: p.address, token: p.baseToken, symbol: p.baseSymbol, quote: p.quoteSymbol, dex: p.dexId, created_at: p.createdAt, reserve_usd: p.reserveUsd, volume: p.volume, tx_m5: p.tx.m5 });
    }
  }

  // ---------- boucle principale ----------
  async tick() {
    const cfg = this.getConfig();
    const now = this.now();
    const jobs = [];
    const due = { solana: [], base: [] };

    for (const t of this.tokens.values()) {
      const age = (now - t.detectedAt) / MIN;
      if (t.chain === "solana") {
        if (!t.swapPair && t.discoverTries < 12 && this.free(`${t.id}:disc`)) jobs.push(this.job(`${t.id}:disc`, () => this.discover(t)));
        if (t.swapPair) {
          for (const m of cfg.solana.snapshot_minutes) if (age >= m && !t.snapsDone.includes(m)) { due.solana.push({ t, m }); break; }
          for (const m of cfg.solana.holders_minutes) {
            const k = `${t.id}:hold${m}`;
            if (age >= m && !t.holdersDone.includes(m) && this.free(k)) jobs.push(this.job(k, () => this.holders(t, m)));
          }
        }
        if (t.curvePair && !t.curveTradesDone && (now - t.detectedAt) / 1000 >= cfg.solana.curve_trades_delay_s && this.free(`${t.id}:ct`)) {
          jobs.push(this.job(`${t.id}:ct`, () => this.curveTrades(t)));
        }
        if (cfg.solana.boost_seconds_candles && t.swapPair && !t.boostSecondsDone && age >= 12 && this.free(`${t.id}:bs`)) {
          jobs.push(this.job(`${t.id}:bs`, () => this.boostSeconds(t)));
        }
        if (age >= cfg.solana.outcome_after_minutes && this.free(`${t.id}:out`)) jobs.push(this.job(`${t.id}:out`, () => this.solanaOutcome(t)));
        // Jeton jamais trouvé sur DexScreener : on abandonne après 3 h.
        if (!t.swapPair && age > 180) { this.journal.write("abandon", { id: t.id, reason: "paire_introuvable" }); this.tokens.delete(t.id); }
      } else if (t.chain === "base") {
        for (const m of cfg.base.snapshot_minutes) if (age >= m && !t.snapsDone.includes(m)) { due.base.push({ t, m }); break; }
        if (age >= cfg.base.outcome_after_minutes && this.free(`${t.id}:out`)) jobs.push(this.job(`${t.id}:out`, () => this.baseOutcome(t)));
      }
    }
    if (due.solana.length && this.free("snap:solana")) jobs.push(this.job("snap:solana", () => this.snapshots("solana", due.solana)));
    if (due.base.length && this.free("snap:base")) jobs.push(this.job("snap:base", () => this.snapshots("base", due.base)));
    await Promise.allSettled(jobs);
  }

  free(key) { return !this.busy.has(key); }
  job(key, fn) {
    this.busy.add(key);
    return (async () => {
      try { await fn(); } catch (e) {
        this.stats.errors += 1;
        this.journal.write("erreur", { job: key, message: String(e?.message ?? e).slice(0, 300) });
      } finally { this.busy.delete(key); }
    })();
  }

  // ---------- étapes Solana ----------
  async discover(t) {
    t.discoverTries += 1;
    const pairs = await this.ds.tokenPairs("solana", t.mint);
    const { swap, curve } = pickSolanaPairs(pairs);
    if (curve && !t.curvePair) t.curvePair = curve.pairAddress;
    if (!swap) return;
    t.swapPair = swap.pairAddress;
    t.quoteUsdAtStart = swap.quoteUsd;
    if (swap.marketCap && swap.quoteUsd) t.mcapSolAtStart = swap.marketCap / swap.quoteUsd;
    this.journal.write("pairs", { id: t.id, swap_pair: t.swapPair, curve_pair: t.curvePair, dex: swap.dexId, symbol: swap.baseSymbol, mcap_usd: swap.marketCap, mcap_sol: t.mcapSolAtStart, liquidity_usd: swap.liquidityUsd });
  }

  async snapshots(chain, items) {
    const addrs = items.map(({ t }) => (chain === "solana" ? t.swapPair : t.pool));
    const pairs = await this.ds.pairs(chain, addrs);
    const byAddr = new Map(pairs.map((p) => [p.pairAddress?.toLowerCase(), p]));
    for (const { t, m } of items) {
      const addr = (chain === "solana" ? t.swapPair : t.pool)?.toLowerCase();
      const p = byAddr.get(addr) ?? null;
      t.snapsDone.push(m);
      if (!p) { this.journal.write("snapshot", { id: t.id, minute: m, missing: true }); continue; }
      if (chain === "solana" && !t.mcapSolAtStart && p.marketCap && p.quoteUsd) t.mcapSolAtStart = p.marketCap / p.quoteUsd;
      if (chain === "base") t.lastSnap = { minute: m, liquidityUsd: p.liquidityUsd, volH1: p.volume.h1 };
      this.journal.write("snapshot", {
        id: t.id, minute: m, age_min: Math.round(((this.now() - t.detectedAt) / MIN) * 10) / 10, price_usd: p.priceUsd, mcap_usd: p.marketCap, liquidity_usd: p.liquidityUsd,
        volume: p.volume, txns: p.txns, price_change: p.priceChange,
      });
    }
  }

  async holders(t, m) {
    const [largest, supply] = await Promise.all([this.rpc.getTokenLargestAccounts(t.mint), this.rpc.getTokenSupply(t.mint)]);
    const accounts = await this.rpc.getMultipleParsed(largest.map((a) => a.address));
    const owners = new Map();
    accounts.forEach((acc, i) => { const o = acc?.data?.parsed?.info?.owner; if (o) owners.set(largest[i].address, o); });
    const conc = holderConcentration({ largest, owners, supply: supply?.uiAmount ?? supply?.uiAmountString, excludedOwners: [t.swapPair, t.curvePair] });
    let authorities = null;
    if (!t.holdersDone.length) {
      const mintAcc = await this.rpc.getParsedAccount(t.mint);
      const info = mintAcc?.data?.parsed?.info;
      authorities = info ? { mint_authority: info.mintAuthority ?? null, freeze_authority: info.freezeAuthority ?? null, program: mintAcc.owner } : null;
    }
    t.holdersDone.push(m);
    this.journal.write("holders", { id: t.id, minute: m, ...conc, authorities });
  }

  async curveTrades(t) {
    const trades = await this.gt.trades("solana", t.curvePair);
    t.curveTradesDone = true;
    this.journal.write("curve_trades", { id: t.id, curve_pair: t.curvePair, metrics: curveTradeMetrics(trades, t.detectedAt) });
  }

  async boostSeconds(t) {
    const candles = await this.gt.ohlcv("solana", t.swapPair, { timeframe: "second", aggregate: 15, limit: 60 });
    t.boostSecondsDone = true;
    this.journal.write("boost_seconds", { id: t.id, candles_15s: candles });
  }

  async solanaOutcome(t) {
    const cfg = this.getConfig();
    let result = { status: "paire_introuvable" };
    let curve = null;
    if (t.swapPair) {
      const limit = Math.min(1000, cfg.solana.outcome_after_minutes + 30);
      const candles = await this.gt.ohlcv("solana", t.swapPair, { timeframe: "minute", aggregate: 1, limit });
      // Départ = premier pool PumpSwap ; si DexScreener date la paire, on prend cette date, sinon la détection.
      result = analyzeTrajectory(candles, Math.floor(t.detectedAt / 1000) - 60, cfg, solanaFeeFactory(cfg, t.mcapSolAtStart));
    }
    if (t.curvePair) {
      const cc = await this.gt.ohlcv("solana", t.curvePair, { timeframe: "minute", aggregate: 1, limit: 300, beforeTs: Math.floor(t.detectedAt / 1000) + 60 });
      curve = cc ? curveMetrics(cc, Math.floor(t.detectedAt / 1000)) : null;
    }
    this.journal.write("outcome", { id: t.id, chain: "solana", mint: t.mint, mcap_sol_at_start: t.mcapSolAtStart, curve, result });
    this.tokens.delete(t.id);
    this.stats.outcomes += 1;
  }

  // ---------- Base ----------
  async baseOutcome(t) {
    const cfg = this.getConfig();
    const s = t.lastSnap;
    const active = s && ((s.liquidityUsd ?? 0) >= cfg.base.outcome_min_liquidity_usd || (s.volH1 ?? 0) >= cfg.base.outcome_min_volume_h1_usd);
    let result;
    if (!active) {
      result = { status: "activite_insuffisante", last_snapshot: s };
    } else {
      const limit = Math.min(1000, cfg.base.outcome_after_minutes + 30);
      const candles = await this.gt.ohlcv("base", t.pool, { timeframe: "minute", aggregate: 1, limit });
      result = analyzeTrajectory(candles, Math.floor(t.detectedAt / 1000), cfg, baseFeeFactory(cfg));
    }
    this.journal.write("outcome", { id: t.id, chain: "base", pool: t.pool, token: t.token, symbol: t.symbol, result });
    this.tokens.delete(t.id);
    this.stats.outcomes += 1;
  }
}
