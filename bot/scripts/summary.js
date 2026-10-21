// Bilan des données enregistrées : lit tout le journal et écrit data/summary/latest.{json,md}.
// Usage : node scripts/summary.js [nombre_de_jours]   (par défaut : tout l'historique)
import fs from "node:fs";
import path from "node:path";
import { loadEnv, dataDir } from "../src/config.js";
import { readJournalFiles } from "../src/journal.js";
import { buildSummary, toMarkdown } from "../src/analysis/summary.js";

loadEnv();
const dir = dataDir();
const days = Number(process.argv[2]) || null;
const jdir = path.join(dir, "journal");
let files = fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((f) => f.endsWith(".jsonl")).sort() : [];
if (days) files = files.slice(-days);
const rows = readJournalFiles(files.map((f) => path.join(jdir, f)));

const summary = buildSummary(rows);
const out = path.join(dir, "summary");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(out, "latest.md"), toMarkdown(summary));
console.log(`Bilan écrit dans ${out} (${rows.length} lignes lues)`);
