// Barème des frais des pools PumpSwap canoniques (jetons migrés depuis pump.fun), par côté,
// selon la capitalisation en SOL. Source : https://pump.fun/docs/fees (consulté le 21.10.2026).
// Au-delà du dernier palier connu, on garde 0,75 % (prudent : le vrai taux continue de baisser).
export const PUMPSWAP_TIERS = [
  [420, 1.25],
  [1470, 1.2],
  [2460, 1.15],
  [3440, 1.1],
  [4420, 1.05],
  [9820, 1.0],
  [14740, 0.95],
  [19650, 0.9],
  [24560, 0.85],
  [29470, 0.8],
  [34380, 0.75],
];

export function pumpswapFeePct(mcapSol) {
  if (!Number.isFinite(mcapSol)) return PUMPSWAP_TIERS[0][1];
  for (const [upTo, pct] of PUMPSWAP_TIERS) if (mcapSol < upTo) return pct;
  return PUMPSWAP_TIERS[PUMPSWAP_TIERS.length - 1][1];
}

// Fonction de coût par côté (en %) en fonction du multiple de prix depuis l'entrée.
// mcapSolAtEntry : capitalisation en SOL au moment de l'entrée.
export function solanaFeeFn(mcapSolAtEntry, slippagePct) {
  return (priceRatio) => pumpswapFeePct(mcapSolAtEntry * priceRatio) + slippagePct;
}

export function flatFeeFn(feePct, slippagePct) {
  return () => feePct + slippagePct;
}
