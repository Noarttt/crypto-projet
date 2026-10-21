import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelOutcome, boostMetrics, immediateEntry, pullbackEntry, higherLowEntry, simulateExit, pathFromEntry,
  curveMetrics, curveTradeMetrics,
} from "../src/analysis/outcome.js";
import { analyzeTrajectory } from "../src/analysis/report.js";
import { readConfig } from "../src/config.js";

// Fabrique des bougies d'une minute à partir d'une liste [o, h, l, c, v].
const T0 = 1_760_000_040; // multiple de 60
const mk = (rows) => rows.map(([o, h, l, c, v = 100], i) => ({ t: T0 + i * 60, o, h, l, c, v }));
const flat = (n, p = 1) => Array.from({ length: n }, () => [p, p, p, p]);

const cfg = readConfig();
const A = cfg.analysis;
const noFees = { feeFn: () => 0, fixedPct: 0 };

test("succès : +50 % sans passer par -25 %", () => {
  const c = mk([[1, 1.1, 0.9, 1.05], [1.05, 1.6, 1.0, 1.5], ...flat(5, 1.5)]);
  const r = labelOutcome(c, 0, 1, A.success, A.failure);
  assert.equal(r.success, true);
  assert.equal(r.failure, false);
  assert.equal(r.max_gain_pct, 60);
});

test("pas de succès si -25 % touché avant (même bougie = prudent)", () => {
  const c = mk([[1, 1.6, 0.7, 1.5], ...flat(5, 1.5)]);
  const r = labelOutcome(c, 0, 1, A.success, A.failure);
  assert.equal(r.success, false);
});

test("échec : -50 % dans les 30 min", () => {
  const c = mk([[1, 1, 0.9, 0.9], [0.9, 0.9, 0.45, 0.5], ...flat(3, 0.5)]);
  assert.equal(labelOutcome(c, 0, 1, A.success, A.failure).failure, true);
});

test("BOOST : survivant si le prix à +5 min tient", () => {
  const c = mk([[1, 1.2, 1, 1.2, 500], [1.2, 1.3, 1.1, 1.25, 500], [1.25, 1.3, 1.1, 1.1, 500], [1.1, 1.15, 1.0, 1.05, 500], [1.05, 1.1, 1.0, 1.02, 500], ...flat(30, 1.02).map((r) => [...r, 100])]);
  const b = boostMetrics(c, 0, 5);
  assert.equal(b.end_idx, 4);
  assert.equal(b.survivor, true);
  assert.equal(b.vol_per_min_boost, 500);
  assert.equal(b.vol_per_min_after, 100);
  assert.equal(b.volume_kept_ratio, 0.2);
});

test("entrée immédiate : attend la bougie suivante après une bougie verte > 15 %", () => {
  const c = mk([[1, 1, 1, 1], [1, 1.25, 1, 1.2], [1.2, 1.2, 1.1, 1.15]]);
  const e = immediateEntry(c, 1, A.entry);
  assert.equal(e.idx, 2);
  assert.equal(e.price, 1.15);
});

test("entrée sur repli : remplie au niveau -10 % sous le dernier plus haut", () => {
  const c = mk([[1, 1.0, 1, 1], [1, 1.0, 0.95, 0.97], [0.97, 0.98, 0.85, 0.88]]);
  const e = pullbackEntry(c, 0, A.entry);
  assert.equal(e.idx, 2);
  assert.ok(Math.abs(e.price - 0.9) < 1e-9);
});

test("entrée sur repli : rien si le prix ouvre déjà sous -15 %", () => {
  const c = mk([[1, 1, 1, 1], [0.8, 0.82, 0.78, 0.8]]);
  assert.equal(pullbackEntry(c, 0, A.entry), null);
});

test("creux plus haut après un repli de 5 %", () => {
  const c = mk([[1, 1, 1, 1], [1, 1, 0.97, 0.98], [0.98, 0.98, 0.93, 0.94], [0.94, 0.97, 0.95, 0.96]]);
  const e = higherLowEntry(c, 0, A.entry);
  assert.equal(e?.idx, 3);
});

test("sortie : stop dur à -20 %", () => {
  const c = mk([[1, 1, 1, 1], [1, 1.05, 0.75, 0.8]]);
  const s = simulateExit(c, { idx: 0, price: 1, intraCandle: false, kind: "t" }, A.exit, { ...noFees, timeExitMin: 90 });
  assert.equal(s.reason, "stop_loss");
  assert.equal(s.pnl_pct, -20);
});

test("sortie : +30 % puis retour => stop remonté à +8 % (moonbag vendue avec)", () => {
  const c = mk([[1, 1, 1, 1], [1, 1.32, 1, 1.3], [1.3, 1.3, 1.0, 1.0]]);
  const s = simulateExit(c, { idx: 0, price: 1, intraCandle: false, kind: "t" }, A.exit, { ...noFees, timeExitMin: 90 });
  assert.equal(s.reason, "stop_remonte");
  // 0,55 × 1,30 + 0,45 × 1,08 - 1 = +20,1 %
  assert.equal(s.pnl_pct, 20.1);
});

test("sortie : +30 puis +80 => moonbag gardée sans stop", () => {
  const c = mk([[1, 1, 1, 1], [1, 1.35, 1, 1.3], [1.3, 1.85, 1.3, 1.8], [1.8, 1.8, 0.5, 0.5]]);
  const s = simulateExit(c, { idx: 0, price: 1, intraCandle: false, kind: "t" }, A.exit, { ...noFees, timeExitMin: 90 });
  assert.equal(s.tp2, true);
  assert.equal(s.remaining_share, 0.1);
  // 0,55 × 1,3 + 0,35 × 1,8 + 0,1 × 0,5 - 1 = +39,5 %
  assert.equal(s.pnl_pct, 39.5);
});

test("sortie au temps sans +30 %", () => {
  const c = mk([[1, 1, 1, 1], ...flat(70, 1.05)]);
  const s = simulateExit(c, { idx: 0, price: 1, intraCandle: false, kind: "t" }, A.exit, { ...noFees, timeExitMin: 60 });
  assert.equal(s.reason, "sortie_temps");
  assert.equal(s.pnl_pct, 5);
});

test("frais : achat + vente au stop", () => {
  const c = mk([[1, 1, 1, 1], [1, 1, 0.75, 0.8]]);
  const s = simulateExit(c, { idx: 0, price: 1, intraCandle: false, kind: "t" }, A.exit, { feeFn: () => 1.75, fixedPct: 0.5, timeExitMin: 90 });
  // frais : 1,75 + 0,5 (achat) + 0,8 × 1,75 + 0,5 (vente) = 4,15
  assert.equal(s.fees_pct, 4.15);
  assert.equal(s.pnl_pct, -24.15);
});

test("trajectoire : tp1 puis tp2", () => {
  const c = mk([[1, 1, 1, 1], [1, 1.4, 1, 1.3], [1.3, 1.9, 1.2, 1.8]]);
  const p = pathFromEntry(c, { idx: 0, price: 1 }, A.exit);
  assert.deepEqual([p.reached_tp1, p.reached_tp2_after_tp1, p.stop_before_tp1], [true, true, false]);
});

test("courbe : minutes avant migration à 80/90/95 %", () => {
  const c = mk([[0.5, 0.5, 0.5, 0.5], [0.5, 0.85, 0.5, 0.85], [0.85, 0.92, 0.85, 0.92], [0.92, 1, 0.92, 1]]);
  const m = curveMetrics(c, T0 + 4 * 60);
  assert.equal(m.min_before_migration_at_80, 3);
  assert.equal(m.min_before_migration_at_90, 2);
  assert.equal(m.min_before_migration_at_95, 1);
});

test("flux de la courbe : acheteurs distincts et flux net", () => {
  const ms = T0 * 1000;
  const trades = [
    { ts: ms - 60_000, kind: "buy", wallet: "a", usd: 100 },
    { ts: ms - 50_000, kind: "buy", wallet: "b", usd: 50 },
    { ts: ms - 40_000, kind: "sell", wallet: "c", usd: 30 },
    { ts: ms + 600_000, kind: "buy", wallet: "d", usd: 999 }, // après la migration : ignoré
  ];
  const m = curveTradeMetrics(trades, ms);
  assert.equal(m.distinct_buyers, 2);
  assert.equal(m.net_flow_usd, 120);
  assert.equal(m.top5_buyers_share_pct, 100);
});

test("analyse complète d'une trajectoire", () => {
  const rows = [[1, 1.3, 1, 1.25, 900], [1.25, 1.4, 1.2, 1.3, 900], [1.3, 1.35, 1.2, 1.22, 800], [1.22, 1.25, 1.15, 1.2, 700], [1.2, 1.22, 1.1, 1.15, 600]];
  for (let i = 0; i < 140; i++) { const p = 1.15 * (1 + i * 0.01); rows.push([p, p * 1.01, p * 0.99, p * 1.005, 200]); }
  const c = mk(rows);
  const r = analyzeTrajectory(c, T0, cfg, () => () => 1.75);
  assert.equal(r.status, "ok");
  assert.equal(r.boost.survivor, true);
  assert.ok(r.entries.immediat.sims.length === 2);
  assert.ok(r.from_post_boost.success);
});
