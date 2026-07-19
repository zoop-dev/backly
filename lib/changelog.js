
import { readFile } from "node:fs/promises";
import path from "node:path";

export function parseChangelog(text) {
  const releases = [];
  let current = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^##\s+v?(\d[^\s—–-]*)\s*[—–-]?\s*(.*)$/);
    if (head) {
      current = { version: head[1], date: head[2].trim(), notes: [] };
      releases.push(current);
      continue;
    }
    if (current && /^\s*[-*]\s+/.test(line)) current.notes.push(line.replace(/^\s*[-*]\s+/, "").trim());
  }
  return releases;
}

export async function readChangelog(dir) {
  const raw = await readFile(path.join(dir, "CHANGELOG.md"), "utf8").catch(() => null);
  return raw ? parseChangelog(raw) : [];
}

export const releaseFor = (releases, version) => releases.find((r) => r.version === version) || null;
