// Point d'entrée du bot – phase 1 (enregistrement seulement, aucun trade).
import path from "node:path";
import { loadEnv, createConfigWatcher, dataDir } from "./config.js";
import { createJournal } from "./journal.js";
import { RateLimiter } from "./http.js";
import { createDexScreener } from "./sources/dexscreener.js";
import { createGeckoTerminal } from "./sources/geckoterminal.js";
import { createSolanaRpc } from "./sources/solanaRpc.js";
import { createPumpPortal } from "./sources/pumpportal.js";
import { Recorder } from "./recorder.js";

loadEnv();
const dir = dataDir();
const journal = createJournal(dir);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const limits = {};
const config = createConfigWatcher((next) => {
  log("[config] nouvelle configuration chargée", next.paused ? "(EN PAUSE)" : "");
  journal.write("config", { paused: next.paused, phase: next.phase });
  for (const [k, v] of Object.entries(next.rate_limits_per_min ?? {})) limits[k]?.setRate(v);
});
const cfg0 = config.get();
limits.geckoterminal = new RateLimiter(cfg0.rate_limits_per_min.geckoterminal);
limits.dexscreener = new RateLimiter(cfg0.rate_limits_per_min.dexscreener);
limits.rpc = new RateLimiter(cfg0.rate_limits_per_min.rpc);

const recorder = new Recorder({
  ds: createDexScreener(limits.dexscreener),
  gt: createGeckoTerminal(limits.geckoterminal),
  rpc: createSolanaRpc(limits.rpc),
  journal,
  getConfig: config.get,
  stateFile: path.join(dir, "state.json"),
  log,
});

if (!process.env.HELIUS_API_KEY) log("[avertissement] HELIUS_API_KEY absente : RPC public utilisé, les détenteurs risquent d'échouer.");
journal.write("demarrage", { phase: cfg0.phase, paused: cfg0.paused, node: process.version });
log(`[démarrage] phase ${cfg0.phase}, données dans ${dir}`);

const pump = createPumpPortal({
  onMigration: (m, raw) => recorder.onSolanaMigration(m, raw),
  onRaw: (msg) => journal.write("pumpportal_brut", { msg }),
  onStatus: (s) => { log(`[pumpportal] ${s}`); journal.write("pumpportal_statut", { statut: s }); },
});

// Boucle de suivi toutes les 5 s (une seule exécution à la fois).
let ticking = false;
const tickTimer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await recorder.tick(); } catch (e) { log("[tick] erreur", e.message); } finally { ticking = false; }
}, 5_000);

// Nouveaux pools Base.
let lastBasePoll = 0;
const baseTimer = setInterval(async () => {
  const every = (config.get().base?.poll_every_s ?? 120) * 1000;
  if (Date.now() - lastBasePoll < every) return;
  lastBasePoll = Date.now();
  try { await recorder.pollBase(); } catch (e) { journal.write("erreur", { job: "base:poll", message: e.message }); }
}, 10_000);

const saveTimer = setInterval(() => { try { recorder.save(); } catch (e) { log("[état] sauvegarde impossible", e.message); } }, 30_000);
const beatTimer = setInterval(() => {
  const s = { ...recorder.stats, suivis: recorder.tokens.size };
  journal.write("pouls", s);
  log("[pouls]", JSON.stringify(s));
}, 10 * 60_000);

function shutdown(sig) {
  log(`[arrêt] ${sig}`);
  for (const t of [tickTimer, baseTimer, saveTimer, beatTimer]) clearInterval(t);
  pump.stop();
  try { recorder.save(); } catch { /* ignore */ }
  journal.write("arret", { signal: sig });
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
