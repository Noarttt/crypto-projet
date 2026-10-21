// Concentration des détenteurs : part du top 10 hors comptes des pools (et hors brûlage).
// largest : [{ address, uiAmount }] (getTokenLargestAccounts)
// owners  : Map adresse du compte de jeton -> propriétaire (getMultipleAccounts jsonParsed)
// excludedOwners : adresses des pools (PumpSwap, courbe) dont les coffres ne comptent pas comme détenteurs.

const BURN_OWNERS = new Set(["1nc1nerator11111111111111111111111111111111"]);

export function holderConcentration({ largest, owners, supply, excludedOwners = [] }) {
  const excluded = new Set([...excludedOwners.filter(Boolean), ...BURN_OWNERS]);
  const total = Number(supply);
  if (!Number.isFinite(total) || total <= 0 || !Array.isArray(largest)) return null;

  const holders = [];
  let excludedAmount = 0;
  for (const acc of largest) {
    const amt = Number(acc.uiAmount ?? acc.uiAmountString ?? 0);
    const owner = owners.get(acc.address) ?? null;
    if (owner && excluded.has(owner)) { excludedAmount += amt; continue; }
    holders.push({ owner: owner ?? acc.address, amount: amt });
  }
  // Plusieurs comptes de jeton peuvent appartenir au même propriétaire.
  const byOwner = new Map();
  for (const h of holders) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + h.amount);
  const sorted = [...byOwner.values()].sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((s, x) => s + x, 0);
  const top1 = sorted[0] ?? 0;
  return {
    top10_pct: round((top10 / total) * 100),
    top1_pct: round((top1 / total) * 100),
    pools_pct: round((excludedAmount / total) * 100),
    counted_holders: sorted.length,
  };
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
