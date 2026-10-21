// Journal append-only en JSON Lines, un fichier par jour (UTC).
import fs from "node:fs";
import path from "node:path";

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createJournal(dir) {
  const journalDir = path.join(dir, "journal");
  fs.mkdirSync(journalDir, { recursive: true });
  return {
    dir: journalDir,
    write(type, record) {
      const now = Date.now();
      const line = JSON.stringify({ t: new Date(now).toISOString(), type, ...record });
      fs.appendFileSync(path.join(journalDir, `${utcDay(now)}.jsonl`), line + "\n");
    },
  };
}

// Lecture de toutes les lignes d'un ou plusieurs fichiers de journal.
export function readJournalFiles(files) {
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* ligne tronquée : ignorée */ }
    }
  }
  return out;
}
