// Chargement de la configuration (config.json, relu périodiquement) et des secrets (.env).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(BOT_DIR, "config.json");

// Lecture minimale d'un fichier .env (CLE=valeur), sans dépendance.
export function loadEnv(file = path.join(BOT_DIR, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function dataDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(BOT_DIR, "data");
}

export function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// Garde la dernière configuration valide ; une config cassée (JSON invalide) n'arrête pas le bot.
export function createConfigWatcher(onChange, everyMs = 60_000) {
  let current = readConfig();
  let lastText = JSON.stringify(current);
  const timer = setInterval(() => {
    try {
      const next = readConfig();
      const text = JSON.stringify(next);
      if (text !== lastText) {
        current = next;
        lastText = text;
        onChange?.(next);
      }
    } catch (e) {
      console.error("[config] config.json illisible, ancienne version conservée :", e.message);
    }
  }, everyMs);
  timer.unref();
  return { get: () => current, stop: () => clearInterval(timer) };
}
