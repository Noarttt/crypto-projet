// Analyses pures sur bougies OHLCV (t en secondes, triées) : étiquettes de résultat, métriques BOOST,
// points d'entrée et simulation des règles de sortie avec frais. Aucune requête réseau ici.
//
// Convention prudente : dans une même bougie, si le plus bas touche le stop et que le plus haut touche
// un objectif, on suppose que le stop a été touché en premier (on ne connaît pas l'ordre intra-bougie).

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const pct = (a, b) => (a / b - 1) * 100;

// Index de la première bougie qui commence à ou après tSec (ou null).
export function indexAtOrAfter(candles, tSec) {
  for (let i = 0; i < candles.length; i++) if (candles[i].t >= tSec) return i;
  return null;
}

// Index de la bougie qui contient tSec (dernière bougie commencée avant ou à tSec).
export function indexContaining(candles, tSec) {
  let idx = null;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].t <= tSec) idx = i;
    else break;
  }
  return idx;
}

const minutesBetween = (candles, i, j) => (candles[j].t - candles[i].t) / 60;

// Étiquette succès / échec depuis un prix de référence p0 (bougie de départ startIdx incluse).
// succès : +gain_pct dans window_min sans être passé d'abord par -max_drawdown_first_pct
// échec  : -loss_pct dans window_min (fenêtre d'échec)
export function labelOutcome(candles, startIdx, p0, success, failure) {
  let reachedGain = false, ddFirst = false, failed = false;
  let maxHigh = p0, minLow = p0, peakMin = 0;
  for (let i = startIdx; i < candles.length; i++) {
    const m = minutesBetween(candles, startIdx, i);
    const k = candles[i];
    if (m < success.window_min) {
      if (k.h > maxHigh) { maxHigh = k.h; peakMin = m; }
      if (k.l < minLow) minLow = k.l;
      if (!reachedGain) {
        const ddHit = k.l <= p0 * (1 - success.max_drawdown_first_pct / 100);
        const gainHit = k.h >= p0 * (1 + success.gain_pct / 100);
        if (ddHit) ddFirst = true; // prudent : le creux compte avant le sommet dans la même bougie
        else if (gainHit && !ddFirst) reachedGain = true;
      }
    }
    if (m < failure.window_min && k.l <= p0 * (1 - failure.loss_pct / 100)) failed = true;
    if (m >= Math.max(success.window_min, failure.window_min)) break;
  }
  return {
    success: reachedGain,
    failure: failed,
    max_gain_pct: r2(pct(maxHigh, p0)),
    max_drawdown_pct: r2(pct(minLow, p0)),
    minutes_to_peak: r2(peakMin),
  };
}

// Métriques autour de BOOST (achats automatiques des premières minutes après la migration).
export function boostMetrics(candles, startIdx, boostMin) {
  const p0 = candles[startIdx].o;
  const tEnd = candles[startIdx].t + boostMin * 60;
  const endIdx = indexContaining(candles, tEnd - 1);
  if (endIdx === null || endIdx < startIdx) return null;
  let volBoost = 0, volAfter = 0, nAfter = 0, maxBoost = p0;
  for (let i = startIdx; i < candles.length; i++) {
    const m = minutesBetween(candles, startIdx, i);
    if (m < boostMin) { volBoost += candles[i].v ?? 0; maxBoost = Math.max(maxBoost, candles[i].h); }
    else if (m < boostMin + 25) { volAfter += candles[i].v ?? 0; nAfter += 1; }
    else break;
  }
  // Creux plus hauts entre la fin de BOOST et +30 min.
  let higherLows = 0, prevLow = null;
  for (let i = endIdx + 1; i < candles.length && minutesBetween(candles, startIdx, i) < boostMin + 25; i++) {
    if (prevLow !== null && candles[i].l > prevLow) higherLows += 1;
    prevLow = candles[i].l;
  }
  const pEnd = candles[endIdx].c;
  return {
    price_end_vs_migration_pct: r2(pct(pEnd, p0)),
    max_during_boost_pct: r2(pct(maxBoost, p0)),
    survivor: pEnd >= p0,
    vol_per_min_boost: r2(volBoost / boostMin),
    vol_per_min_after: nAfter ? r2(volAfter / nAfter) : null,
    volume_kept_ratio: nAfter && volBoost ? r2((volAfter / nAfter) / (volBoost / boostMin)) : null,
    higher_lows_5_30: higherLows,
    end_idx: endIdx,
  };
}

// ---------- Points d'entrée (après BOOST) ----------

// Achat « immédiat » à la clôture de la fin de BOOST, sauf grosse bougie verte : on attend la suivante.
export function immediateEntry(candles, boostEndIdx, entryCfg) {
  let j = boostEndIdx;
  const k = candles[j];
  if (k && pct(k.c, k.o) > entryCfg.skip_green_candle_pct) j += 1;
  if (j >= candles.length) return null;
  return { idx: j, price: candles[j].c, intraCandle: false, kind: "immediat" };
}

// Achat sur repli de pullback_min..pullback_max % sous le dernier plus haut, dans la fenêtre donnée.
export function pullbackEntry(candles, boostEndIdx, entryCfg) {
  let high = candles[boostEndIdx].h;
  for (let i = boostEndIdx + 1; i < candles.length; i++) {
    if (minutesBetween(candles, boostEndIdx, i) > entryCfg.pullback_window_min) break;
    const k = candles[i];
    const top = high * (1 - entryCfg.pullback_min_pct / 100);
    const bot = high * (1 - entryCfg.pullback_max_pct / 100);
    if (k.o <= top && k.o >= bot) return { idx: i, price: k.o, intraCandle: true, kind: "repli" };
    if (k.o > top && k.l <= top) return { idx: i, price: top, intraCandle: true, kind: "repli" };
    high = Math.max(high, k.h);
  }
  return null;
}

// Achat au premier creux plus haut après un repli d'au moins higher_low_min_dip_pct (bougie verte).
export function higherLowEntry(candles, boostEndIdx, entryCfg) {
  let high = candles[boostEndIdx].h;
  let dipped = false;
  for (let i = boostEndIdx + 2; i < candles.length; i++) {
    if (minutesBetween(candles, boostEndIdx, i) > entryCfg.pullback_window_min) break;
    const a = candles[i - 2], b = candles[i - 1], k = candles[i];
    high = Math.max(high, b.h);
    if (pct(b.l, high) <= -entryCfg.higher_low_min_dip_pct) dipped = true;
    const swingLow = b.l <= a.l;
    if (dipped && swingLow && k.l > b.l && k.c > k.o) return { idx: i, price: k.c, intraCandle: false, kind: "creux_plus_haut" };
  }
  return null;
}

// ---------- Simulation des règles de sortie ----------
// feeFn(priceRatio) -> % de frais par côté (pool + slippage) ; fixedPct : frais fixes par transaction en % de la position.
export function simulateExit(candles, entry, exitCfg, { feeFn, fixedPct, timeExitMin }) {
  const e = entry.price;
  const startIdx = entry.idx + 1; // les sorties sont évaluées à partir de la bougie suivante
  const tStart = candles[entry.idx].t + (entry.intraCandle ? 0 : 60);
  let main = 1 - exitCfg.moonbag_share; // part principale
  let moon = exitCfg.moonbag_share;     // moonbag (sort avec le reste tant que tp2 n'est pas atteint si moonbag_requires_tp2)
  let proceeds = 0, fees = 0, txs = 1;
  let stop = e * (1 - exitCfg.stop_loss_pct / 100);
  let tp1 = false, tp2 = false, reason = null;
  const moonSteps = (exitCfg.moonbag_multiples ?? []).map(([mult, share]) => ({ mult, share, done: false }));
  const moonInitial = moon;

  fees += feeFn(1) + fixedPct; // achat

  const sell = (share, price) => {
    if (share <= 1e-9) return;
    const value = share * (price / e);
    proceeds += value;
    fees += value * feeFn(price / e) + fixedPct;
    txs += 1;
  };

  let lastClose = e, i = startIdx;
  for (; i < candles.length; i++) {
    const k = candles[i];
    const elapsed = (k.t - tStart) / 60;
    if (elapsed >= exitCfg.sim_horizon_min) break;
    lastClose = k.c;

    if (main > 1e-9) {
      // 1) stop (dur ou remonté), vérifié en premier par prudence
      if (k.l <= stop) {
        const px = Math.min(stop, k.o); // si la bougie ouvre déjà sous le stop, on vend à l'ouverture
        const withMoon = !tp2 && exitCfg.moonbag_requires_tp2;
        sell(main + (withMoon ? moon : 0), px);
        if (withMoon) moon = 0;
        main = 0;
        reason = tp1 ? "stop_remonte" : "stop_loss";
      } else {
        // 2) premier objectif
        if (!tp1 && k.h >= e * (1 + exitCfg.tp1_pct / 100)) {
          sell(exitCfg.tp1_sell_share, e * (1 + exitCfg.tp1_pct / 100));
          main -= exitCfg.tp1_sell_share;
          tp1 = true;
          stop = e * (1 + exitCfg.stop_after_tp1_pct / 100);
        }
        // 3) second objectif
        if (tp1 && !tp2 && k.h >= e * (1 + exitCfg.tp2_pct / 100)) {
          const share = Math.min(exitCfg.tp2_sell_share, main);
          sell(share, e * (1 + exitCfg.tp2_pct / 100));
          main -= share;
          tp2 = true;
          reason = "tp2";
        }
        // 4) sortie au temps si +tp1 jamais atteint
        if (!tp1 && elapsed >= timeExitMin) {
          sell(main + moon, k.c);
          main = 0; moon = 0;
          reason = "sortie_temps";
        }
      }
    }
    // Moonbag : seulement si conservée (tp2 atteint ou règle désactivée), sans stop ni limite de temps.
    if (moon > 1e-9 && (tp2 || !exitCfg.moonbag_requires_tp2)) {
      for (const s of moonSteps) {
        if (!s.done && k.h >= e * s.mult) {
          const share = Math.min(moonInitial * s.share, moon);
          sell(share, e * s.mult);
          moon -= share;
          s.done = true;
        }
      }
    }
    if (main <= 1e-9 && moon <= 1e-9) break;
  }

  // Ce qui reste à l'horizon est valorisé à la dernière clôture (sans frais de vente : moonbag gardée ou abandonnée).
  const remaining = main + moon;
  const mtm = remaining * (lastClose / e);
  if (!reason) reason = remaining > 1e-9 ? (tp1 ? "en_cours_apres_tp1" : "en_cours") : "complet";
  const grossPct = (proceeds + mtm - 1) * 100;
  return {
    entry_kind: entry.kind,
    time_exit_min: timeExitMin,
    pnl_pct: r2(grossPct - fees),
    gross_pct: r2(grossPct),
    fees_pct: r2(fees),
    remaining_share: r2(remaining),
    remaining_mtm_pct: r2(mtm * 100),
    tp1,
    tp2,
    txs,
    reason,
  };
}

// Trajectoire depuis une entrée : +tp1 atteint ? puis +tp2 ? stop dur touché avant tp1 ?
export function pathFromEntry(candles, entry, exitCfg) {
  const e = entry.price;
  let tp1 = false, tp2 = false, stopFirst = false, maxPct = 0;
  const tStart = candles[entry.idx].t;
  for (let i = entry.idx + 1; i < candles.length; i++) {
    const k = candles[i];
    if ((k.t - tStart) / 60 > exitCfg.sim_horizon_min) break;
    maxPct = Math.max(maxPct, pct(k.h, e));
    if (!tp1 && k.l <= e * (1 - exitCfg.stop_loss_pct / 100)) { stopFirst = true; break; }
    if (!tp1 && k.h >= e * (1 + exitCfg.tp1_pct / 100)) tp1 = true;
    if (tp1 && k.h >= e * (1 + exitCfg.tp2_pct / 100)) { tp2 = true; break; }
  }
  return { reached_tp1: tp1, reached_tp2_after_tp1: tp2, stop_before_tp1: stopFirst, max_gain_pct: r2(maxPct) };
}

// ---------- Courbe de liaison (avant migration) ----------

// Temps (min avant la migration) où le prix de la courbe a atteint 80/90/95 % du prix final.
export function curveMetrics(candles, migrationSec) {
  const pre = candles.filter((k) => k.t < migrationSec);
  if (pre.length === 0) return null;
  const pf = pre[pre.length - 1].c;
  const out = { curve_age_min: r2((migrationSec - pre[0].t) / 60), final_price_usd: pf };
  for (const lvl of [80, 90, 95]) {
    const hit = pre.find((k) => k.h >= pf * (lvl / 100));
    out[`min_before_migration_at_${lvl}`] = hit ? r2((migrationSec - hit.t) / 60) : null;
  }
  return out;
}

// Flux d'achats/ventes sur la courbe juste avant la migration (300 derniers trades au plus).
export function curveTradeMetrics(trades, migrationMs) {
  const pre = (trades ?? []).filter((t) => t.ts !== null && t.ts <= migrationMs + 5_000 && Number.isFinite(t.usd));
  if (pre.length === 0) return null;
  const buyers = new Map();
  const sellers = new Set();
  let buyUsd = 0, sellUsd = 0;
  for (const t of pre) {
    if (t.kind === "buy") { buyUsd += t.usd; buyers.set(t.wallet, (buyers.get(t.wallet) ?? 0) + t.usd); }
    else if (t.kind === "sell") { sellUsd += t.usd; sellers.add(t.wallet); }
  }
  const topBuys = [...buyers.values()].sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0);
  const ts = pre.map((t) => t.ts);
  return {
    trades: pre.length,
    span_min: r2((Math.max(...ts) - Math.min(...ts)) / 60_000),
    distinct_buyers: buyers.size,
    distinct_sellers: sellers.size,
    buy_usd: r2(buyUsd),
    sell_usd: r2(sellUsd),
    net_flow_usd: r2(buyUsd - sellUsd),
    top5_buyers_share_pct: buyUsd ? r2((topBuys / buyUsd) * 100) : null,
  };
}
