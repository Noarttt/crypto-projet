// Calcul du bilan (fonctions pures) à partir des lignes du journal.

export function buildSummary(rows) {
  const holders = new Map();
  const curveTrades = new Map();
  const outcomes = [];
  let migrations = 0, basePools = 0, errors = 0;
  for (const r of rows) {
    if (r.type === "migration") migrations += 1;
    else if (r.type === "base_pool") basePools += 1;
    else if (r.type === "erreur") errors += 1;
    else if (r.type === "holders") { const prev = holders.get(r.id); if (!prev || r.minute >= prev.minute) holders.set(r.id, r); }
    else if (r.type === "curve_trades") curveTrades.set(r.id, r.metrics);
    else if (r.type === "outcome") outcomes.push(r);
  }

  const ok = (o) => o.result?.status === "ok";
  const sol = outcomes.filter((o) => o.chain === "solana");
  const solOk = sol.filter(ok);
  const base = outcomes.filter((o) => o.chain === "base");
  const baseOk = base.filter(ok);

  const rate = (arr, f) => (arr.length ? round((arr.filter(f).length / arr.length) * 100) : null);
  const group = (arr, keyFn, buckets) => {
    const out = {};
    for (const b of buckets) {
      const sub = arr.filter((o) => keyFn(o) === b);
      out[b] = { n: sub.length, succes_apres_boost_pct: rate(sub, (o) => o.result.from_post_boost?.success), echec_pct: rate(sub, (o) => o.result.from_start?.failure) };
    }
    return out;
  };
  const bucket = (x, edges, labels) => {
    if (!Number.isFinite(x)) return "inconnu";
    for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i];
    return labels[labels.length - 1];
  };

  const entryStats = (arr) => {
    const out = {};
    for (const name of ["immediat", "repli", "creux_plus_haut"]) {
      const withEntry = arr.filter((o) => o.result.entries?.[name]);
      const variants = {};
      for (const o of withEntry) for (const s of o.result.entries[name].sims) (variants[s.time_exit_min] ??= []).push(s.pnl_pct);
      out[name] = {
        entrees: withEntry.length,
        sur: arr.length,
        tp1_atteint_pct: rate(withEntry, (o) => o.result.entries[name].path.reached_tp1),
        tp2_apres_tp1_pct: (() => { const t1 = withEntry.filter((o) => o.result.entries[name].path.reached_tp1); return rate(t1, (o) => o.result.entries[name].path.reached_tp2_after_tp1); })(),
        stop_avant_tp1_pct: rate(withEntry, (o) => o.result.entries[name].path.stop_before_tp1),
        simulation_par_sortie_temps: Object.fromEntries(Object.entries(variants).map(([k, v]) => [`${k}min`, {
          pnl_moyen_pct: round(avg(v)), pnl_median_pct: round(median(v)), gagnants_pct: round((v.filter((x) => x > 0).length / v.length) * 100),
        }])),
      };
    }
    out.gagnants_manques_repli = arr.filter((o) => o.result.missed_winner_pullback).length;
    out.gagnants_manques_creux = arr.filter((o) => o.result.missed_winner_higher_low).length;
    return out;
  };

  const top10 = (o) => holders.get(o.id)?.top10_pct;
  const buyers = (o) => curveTrades.get(o.id)?.distinct_buyers;
  const solana = {
    migrations_detectees: migrations,
    resultats: sol.length,
    analysables: solOk.length,
    depuis_migration: {
      succes_pct: rate(solOk, (o) => o.result.from_start.success),
      echec_pct: rate(solOk, (o) => o.result.from_start.failure),
      gain_max_median_pct: round(median(solOk.map((o) => o.result.from_start.max_gain_pct))),
    },
    boost: {
      survivants_pct: rate(solOk, (o) => o.result.boost?.survivor),
      succes_apres_boost_si_survivant_pct: rate(solOk.filter((o) => o.result.boost?.survivor), (o) => o.result.from_post_boost.success),
      succes_apres_boost_si_non_survivant_pct: rate(solOk.filter((o) => !o.result.boost?.survivor), (o) => o.result.from_post_boost.success),
      volume_conserve_median: round(median(solOk.map((o) => o.result.boost?.volume_kept_ratio))),
    },
    par_top10_detenteurs: group(solOk, (o) => bucket(top10(o), [20, 30], ["<20 %", "20-30 %", ">=30 %"]), ["<20 %", "20-30 %", ">=30 %", "inconnu"]),
    par_acheteurs_distincts_courbe: group(solOk, (o) => bucket(buyers(o), [50, 100], ["<50", "50-100", ">=100"]), ["<50", "50-100", ">=100", "inconnu"]),
    par_mcap_sol_migration: group(solOk, (o) => bucket(o.mcap_sol_at_start, [420, 1470], ["<420", "420-1470", ">=1470"]), ["<420", "420-1470", ">=1470", "inconnu"]),
    entrees: entryStats(solOk),
  };

  const liq = (o) => o.result?.last_snapshot?.liquidityUsd;
  const baseOut = {
    pools_detectes: basePools,
    resultats: base.length,
    filtres_activite_insuffisante: base.filter((o) => o.result?.status === "activite_insuffisante").length,
    analysables: baseOk.length,
    succes_depuis_lancement_pct: rate(baseOk, (o) => o.result.from_start.success),
    echec_pct: rate(baseOk, (o) => o.result.from_start.failure),
    entrees: entryStats(baseOk),
    liquidite_mediane_filtres_usd: round(median(base.filter((o) => o.result?.status === "activite_insuffisante").map(liq))),
  };

  return { genere_le: new Date().toISOString(), lignes_journal: rows.length, erreurs: errors, solana, base: baseOut };
}

function avg(v) { const a = v.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(v) { const a = v.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function round(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; }

export function toMarkdown(s) {
  const L = [];
  const f = (x, unit = "") => (x === null || x === undefined ? "–" : `${x}${unit}`);
  L.push(`# Bilan phase 1 – enregistrement`, "", `Généré le ${s.genere_le} · ${s.lignes_journal} lignes de journal · ${s.erreurs} erreurs`, "");
  const S = s.solana;
  L.push("## Solana (migrations pump.fun → PumpSwap)", "");
  L.push(`- Migrations détectées : ${S.migrations_detectees}, résultats : ${S.resultats}, analysables : ${S.analysables}`);
  L.push(`- Depuis la migration : succès ${f(S.depuis_migration.succes_pct, " %")}, échec ${f(S.depuis_migration.echec_pct, " %")}, gain max médian ${f(S.depuis_migration.gain_max_median_pct, " %")}`);
  L.push(`- BOOST : survivants ${f(S.boost.survivants_pct, " %")} ; succès après BOOST si survivant ${f(S.boost.succes_apres_boost_si_survivant_pct, " %")}, sinon ${f(S.boost.succes_apres_boost_si_non_survivant_pct, " %")} ; volume conservé médian ${f(S.boost.volume_conserve_median)}`);
  for (const [title, g] of [["Top 10 détenteurs (hors pools)", S.par_top10_detenteurs], ["Acheteurs distincts sur la courbe", S.par_acheteurs_distincts_courbe], ["Capitalisation en SOL à la migration", S.par_mcap_sol_migration]]) {
    L.push("", `### ${title}`, "", "| Tranche | n | Succès après BOOST | Échec |", "|---|---|---|---|");
    for (const [k, v] of Object.entries(g)) L.push(`| ${k} | ${v.n} | ${f(v.succes_apres_boost_pct, " %")} | ${f(v.echec_pct, " %")} |`);
  }
  const entries = (E, title) => {
    L.push("", `### ${title}`, "", "| Entrée | Entrées | TP1 atteint | TP2 après TP1 | Stop avant TP1 | PnL moyen (60 / 90 min) | Gagnants (60 / 90 min) |", "|---|---|---|---|---|---|---|");
    for (const name of ["immediat", "repli", "creux_plus_haut"]) {
      const e = E[name]; const s60 = e.simulation_par_sortie_temps["60min"] ?? {}; const s90 = e.simulation_par_sortie_temps["90min"] ?? {};
      L.push(`| ${name} | ${e.entrees}/${e.sur} | ${f(e.tp1_atteint_pct, " %")} | ${f(e.tp2_apres_tp1_pct, " %")} | ${f(e.stop_avant_tp1_pct, " %")} | ${f(s60.pnl_moyen_pct, " %")} / ${f(s90.pnl_moyen_pct, " %")} | ${f(s60.gagnants_pct, " %")} / ${f(s90.gagnants_pct, " %")} |`);
    }
    L.push("", `Gagnants manqués : repli ${E.gagnants_manques_repli}, creux plus haut ${E.gagnants_manques_creux}`);
  };
  entries(S.entrees, "Entrées simulées (Solana, frais compris)");
  const B = s.base;
  L.push("", "## Base (nouveaux pools)", "");
  L.push(`- Pools détectés : ${B.pools_detectes}, résultats : ${B.resultats}, écartés pour activité insuffisante : ${B.filtres_activite_insuffisante}, analysables : ${B.analysables}`);
  L.push(`- Depuis le lancement : succès ${f(B.succes_depuis_lancement_pct, " %")}, échec ${f(B.echec_pct, " %")}`);
  entries(B.entrees, "Entrées simulées (Base, frais compris)");
  L.push("", "_Simulations sur bougies d'une minute, stop supposé touché en premier dans une bougie ambiguë ; moonbag restante valorisée à la dernière clôture de la fenêtre._");
  return L.join("\n") + "\n";
}

