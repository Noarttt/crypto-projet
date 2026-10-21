// Flux temps réel PumpPortal : une seule connexion WebSocket, abonnement gratuit aux migrations.
// Utilise le WebSocket natif de Node (>= 22.4), sans dépendance.

const URL_BASE = "wss://pumpportal.fun/api/data";

// Extrait l'adresse du jeton d'un message de migration, quel que soit le nom exact du champ.
export function parseMigration(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.message && !msg.mint) return null; // accusé de réception d'abonnement
  const txType = String(msg.txType ?? msg.type ?? "").toLowerCase();
  const mint = msg.mint ?? msg.token ?? msg.tokenAddress ?? null;
  if (!mint) return null;
  if (txType && !txType.includes("migrat")) return null;
  return {
    mint,
    signature: msg.signature ?? null,
    pool: msg.pool ?? null,
  };
}

export function createPumpPortal({ onMigration, onRaw, onStatus, maxBackoffMs = 60_000 }) {
  let ws = null;
  let stopped = false;
  let backoff = 2_000;
  let rawLogged = 0;
  let lastMessageAt = Date.now();

  const url = process.env.PUMPPORTAL_API_KEY ? `${URL_BASE}?api-key=${encodeURIComponent(process.env.PUMPPORTAL_API_KEY)}` : URL_BASE;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      backoff = 2_000;
      lastMessageAt = Date.now();
      onStatus?.("connecté");
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    ws.addEventListener("message", (ev) => {
      lastMessageAt = Date.now();
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
      // Les 20 premiers messages bruts sont journalisés pour vérifier le format réel.
      if (rawLogged < 20) { rawLogged += 1; onRaw?.(msg); }
      const m = parseMigration(msg);
      if (m) onMigration(m, msg);
    });
    ws.addEventListener("close", () => {
      onStatus?.(`déconnecté, nouvelle tentative dans ${Math.round(backoff / 1000)} s`);
      if (!stopped) setTimeout(connect, backoff);
      backoff = Math.min(maxBackoffMs, backoff * 2);
    });
    ws.addEventListener("error", () => { /* "close" suit toujours ; reconnexion gérée là */ });
  };

  // Si aucun message pendant 15 min, on force une reconnexion (connexion silencieusement morte).
  const watchdog = setInterval(() => {
    if (!stopped && ws && Date.now() - lastMessageAt > 15 * 60_000) {
      onStatus?.("aucun message depuis 15 min, reconnexion");
      lastMessageAt = Date.now();
      try { ws.close(); } catch { /* ignore */ }
    }
  }, 60_000);
  watchdog.unref();

  connect();
  return {
    stop() {
      stopped = true;
      clearInterval(watchdog);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
