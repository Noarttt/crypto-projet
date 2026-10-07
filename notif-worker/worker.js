/* Veille crypto : notifications en arrière-plan.
   Cloudflare Worker (offre gratuite) : toutes les minutes, vérifie tes alertes de prix (CoinGecko)
   et t'envoie une notification via ntfy.sh. Une seule configuration (la tienne), stockée dans KV sous la clé "cfg".
   Liaison KV à créer sous le nom : KV. Déclencheur cron : * * * * * */
const CORS = {"Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"POST, GET, OPTIONS", "Access-Control-Allow-Headers":"Content-Type"};
const J = (o, s) => new Response(JSON.stringify(o), {status: s || 200, headers: Object.assign({"Content-Type":"application/json"}, CORS)});
const num = v => (v === null || v === undefined || v === "" || !isFinite(Number(v))) ? null : Number(v);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, {headers: CORS});
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/sync") {
      let b; try { b = await req.json(); } catch (e) { return J({error:"JSON invalide"}, 400); }
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(b.topic || "") || !/^[A-Za-z0-9_-]{16,64}$/.test(b.token || "")) return J({error:"topic ou jeton invalide"}, 400);
      if (!/^[a-z]{3,5}$/.test(b.cur || "")) return J({error:"devise invalide"}, 400);
      if (!Array.isArray(b.alerts) || b.alerts.length > 200) return J({error:"alertes invalides"}, 400);
      const old = await env.KV.get("cfg", "json");
      if (old && old.token !== b.token) return J({error:"Ce Worker est déjà lié à un autre jeton (supprime la clé cfg dans KV pour le réinitialiser)."}, 403);
      const alerts = b.alerts.filter(a => /^[a-z0-9-]{1,80}$/.test(a.id || "")).map(a => ({id:a.id, sym:String(a.sym || a.id).slice(0, 20), above:num(a.above), below:num(a.below), move:num(a.move)}));
      await env.KV.put("cfg", JSON.stringify({topic:b.topic, token:b.token, cur:b.cur, alerts}));
      return J({ok:true, alerts:alerts.length});
    }
    return J({ok:true, name:"veille-crypto-notif"});
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(run(env)); }
};

async function run(env) {
  const cfg = await env.KV.get("cfg", "json");
  if (!cfg || !cfg.alerts.length) return;
  const ids = [...new Set(cfg.alerts.map(a => a.id))];
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + ids.join(",") + "&vs_currencies=" + cfg.cur + "&include_24hr_change=true", {headers:{accept:"application/json"}});
  if (!r.ok) return;
  const px = await r.json();
  const fired = (await env.KV.get("fired", "json")) || {};
  const next = {}, msgs = [];
  for (const a of cfg.alerts) {
    const d = px[a.id]; if (!d || d[cfg.cur] == null) continue;
    const price = d[cfg.cur], chg = d[cfg.cur + "_24h_change"];
    const checks = [
      ["above", a.above, a.above != null && price >= a.above, "prix au-dessus de " + a.above],
      ["below", a.below, a.below != null && price <= a.below, "prix sous " + a.below],
      ["move", a.move, a.move != null && chg != null && Math.abs(chg) >= a.move, "variation 24 h au-delà de " + a.move + " % (" + (chg == null ? "?" : chg.toFixed(1)) + " %)"]
    ];
    for (const [key, thr, cond, text] of checks) {
      const k = a.id + ":" + key;
      if (!cond) continue;
      next[k] = thr;
      if (fired[k] !== thr) msgs.push(a.sym + " : " + text + " (actuel " + price + " " + cfg.cur.toUpperCase() + ")");
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(fired)) await env.KV.put("fired", JSON.stringify(next));
  if (msgs.length) await fetch("https://ntfy.sh/" + cfg.topic, {method:"POST", headers:{Title:"Veille crypto", Priority:"high", Tags:"chart_with_upwards_trend"}, body:msgs.join("\n")});
}
