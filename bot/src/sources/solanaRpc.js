// Appels JSON-RPC Solana (Helius si une clé est fournie, sinon RPC public).
import { fetchJson } from "../http.js";

export function rpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : "https://api.mainnet-beta.solana.com";
}

export function createSolanaRpc(limiter, url = rpcUrl()) {
  let id = 0;
  const call = async (method, params) => {
    const res = await fetchJson(url, { limiter, method: "POST", body: { jsonrpc: "2.0", id: ++id, method, params } });
    if (res?.error) throw new Error(`RPC ${method} : ${res.error.message ?? JSON.stringify(res.error)}`);
    return res?.result;
  };
  return {
    call,
    getParsedAccount: async (address) => (await call("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]))?.value ?? null,
    getMultipleParsed: async (addresses) => (await call("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }]))?.value ?? [],
    getTokenSupply: async (mint) => (await call("getTokenSupply", [mint, { commitment: "confirmed" }]))?.value ?? null,
    getTokenLargestAccounts: async (mint) => (await call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]))?.value ?? [],
  };
}
