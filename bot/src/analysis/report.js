// Assemble les analyses d'un jeton suivi en un enregistrement « outcome » pour le journal.
import {
  labelOutcome, boostMetrics, immediateEntry, pullbackEntry, higherLowEntry,
  simulateExit, pathFromEntry, indexAtOrAfter, curveMetrics,
} from "./outcome.js";
import { solanaFeeFn, flatFeeFn } from "./fees.js";

// candles : bougies 1 min du pool après migration/lancement ; startSec : instant de départ (s).
// feeFactory(entryPrice) -> feeFn ; quoteUsd et mcapAtStartUsd servent au palier de frais.
export function analyzeTrajectory(candles, startSec, cfg, feeFactory) {
  const a = cfg.analysis;
  if (!candles || candles.length < 3) return { status: "pas_assez_de_bougies", candles: candles?.length ?? 0 };
  const startIdx = indexAtOrAfter(candles, startSec - 59);
  if (startIdx === null) return { status: "pas_de_bougie_apres_le_depart", candles: candles.length };
  const p0 = candles[startIdx].o;

  const out = {
    status: "ok",
    candles: candles.length - startIdx,
    price_start_usd: p0,
    from_start: labelOutcome(candles, startIdx, p0, a.success, a.failure),
  };

  const boost = boostMetrics(candles, startIdx, a.boost_window_min);
  if (!boost) return { ...out, status: "fenetre_boost_incomplete" };
  const { end_idx: boostEndIdx, ...boostPublic } = boost;
  out.boost = boostPublic;
  const pAfter = candles[boostEndIdx].c;
  out.from_post_boost = labelOutcome(candles, boostEndIdx + 1 < candles.length ? boostEndIdx + 1 : boostEndIdx, pAfter, a.success, a.failure);

  const fixedPct = (a.costs.fixed_cost_usd_per_tx / a.costs.position_usd) * 100;
  const entries = [
    immediateEntry(candles, boostEndIdx, a.entry),
    pullbackEntry(candles, boostEndIdx, a.entry),
    higherLowEntry(candles, boostEndIdx, a.entry),
  ];
  out.entries = {};
  for (const [name, entry] of [["immediat", entries[0]], ["repli", entries[1]], ["creux_plus_haut", entries[2]]]) {
    if (!entry) { out.entries[name] = null; continue; }
    const feeFn = feeFactory(entry.price / p0);
    out.entries[name] = {
      minutes_after_start: Math.round((candles[entry.idx].t - candles[startIdx].t) / 60),
      price_vs_start_pct: Math.round((entry.price / p0 - 1) * 10000) / 100,
      path: pathFromEntry(candles, entry, a.exit),
      sims: a.exit.time_exit_min_variants.map((tm) => simulateExit(candles, entry, a.exit, { feeFn, fixedPct, timeExitMin: tm })),
    };
  }
  // Gagnant manqué : le repli ne s'est jamais présenté alors que le jeton a réussi après BOOST.
  out.missed_winner_pullback = !entries[1] && out.from_post_boost.success;
  out.missed_winner_higher_low = !entries[2] && out.from_post_boost.success;
  return out;
}

// Frais Solana : palier PumpSwap selon la capitalisation en SOL au prix d'entrée.
export function solanaFeeFactory(cfg, mcapSolAtStart) {
  return (entryRatio) => solanaFeeFn((mcapSolAtStart ?? 0) * entryRatio, cfg.analysis.costs.slippage_pct_per_side);
}

export function baseFeeFactory(cfg) {
  return () => flatFeeFn(cfg.base.fee_pct_per_side, cfg.analysis.costs.slippage_pct_per_side);
}

export { curveMetrics };
