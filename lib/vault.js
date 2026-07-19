
import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { c, expand, shortHome, humanSize, HOME } from "./ui.js";
import { exists, mapToManifest, manifestToMap } from "./engine.js";

export const CFG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "backly");
export const CFG_PATH = path.join(CFG_DIR, "config.json");
export const DEFAULT_DEST = path.join(HOME, "backups", "backly");
export const DEFAULT_EXCLUDE = [
  "node_modules", "dist", "build", ".next", ".cache",
  ".wrangler", ".vite", ".turbo", ".DS_Store", "*.log",
];

export async function loadCfg() {
  if (!(await exists(CFG_PATH))) return { dest: DEFAULT_DEST, exclude: [...DEFAULT_EXCLUDE], paths: [], mode: "snapshot" };
  const cfg = JSON.parse(await readFile(CFG_PATH, "utf8"));
  cfg.dest ||= DEFAULT_DEST;
  cfg.exclude ||= [...DEFAULT_EXCLUDE];
  cfg.paths ||= [];
  cfg.mode ||= "snapshot";
  return cfg;
}
export async function saveCfg(cfg) {
  await mkdir(CFG_DIR, { recursive: true });
  await writeFile(CFG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export async function driveStatus(dest) {
  const m = dest.match(/^((?:\/run)?\/media\/[^/]+\/[^/]+)/);
  if (!m) return { guarded: false };
  const mp = m[1];
  const here = await stat(mp).catch(() => null);
  if (!here) return { guarded: true, mounted: false, mountpoint: mp };
  const parent = await stat(path.dirname(mp)).catch(() => null);
  return { guarded: true, mounted: parent ? here.dev !== parent.dev : true, mountpoint: mp };
}

export function resolveEntries(cfg, token) {
  if (!token || token === "all") {
    if (!cfg.paths.length) throw new Error("nothing registered yet.  add one with " + c.cyan("backly add <path>") + ".");
    return cfg.paths;
  }
  const abs = path.resolve(expand(token));
  const found = cfg.paths.filter((e) => e.name === token || e.path === abs);
  if (!found.length) throw new Error(`unknown target '${token}'.  Run ${c.cyan("backly list")} to see registered paths.`);
  return found;
}

export async function resolveStorage(cfg, token) {
  const orphan = (name) => ({ name, path: null, orphan: true });
  const onDisk = async () => (await readdir(cfg.dest, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory()).map((d) => d.name);

  if (!token || token === "all") {
    const names = new Set(cfg.paths.map((e) => e.name));
    for (const n of await onDisk()) names.add(n);
    if (!names.size) throw new Error("nothing stored yet.  add a path with " + c.cyan("backly add <path>") + ".");
    return [...names].map((n) => cfg.paths.find((e) => e.name === n) ?? orphan(n));
  }
  const abs = path.resolve(expand(token));
  const found = cfg.paths.filter((e) => e.name === token || e.path === abs);
  if (found.length) return found;
  if ((await onDisk()).includes(token)) return [orphan(token)];
  throw new Error(`unknown target '${token}'.  Run ${c.cyan("backly list")} to see registered paths.`);
}

export const MODES = ["snapshot", "mirror"];

export const effectiveMode = (cfg, entry) => entry?.mode ?? cfg?.mode ?? "snapshot";

export async function editEntry(cfg, name, { newName, path: newPath, exclude, mode } = {}) {
  const entry = cfg.paths.find((e) => e.name === name);
  if (!entry) throw new Error(`not registered: ${name}`);

  if (newPath !== undefined && newPath !== null && newPath !== "") {
    const abs = path.resolve(expand(newPath));
    if (!(await exists(abs))) throw new Error(`no such path: ${abs}`);
    if (cfg.paths.some((e) => e !== entry && e.path === abs)) throw new Error(`another entry already tracks ${abs}`);
    entry.path = abs;
  }

  if (newName && newName !== name) {
    if (!/^[\w.@-]+$/.test(newName)) throw new Error("name may only contain letters, numbers, . _ - @");
    if (cfg.paths.some((e) => e !== entry && e.name === newName)) throw new Error(`name '${newName}' is taken`);
    const from = path.join(cfg.dest, name);
    const to = path.join(cfg.dest, newName);
    if (await exists(to)) throw new Error(`vault already has storage named '${newName}'`);
    if (await exists(from)) await rename(from, to);
    entry.name = newName;
  }

  if (Array.isArray(exclude)) {
    const ex = exclude.map((x) => String(x).trim()).filter(Boolean);
    if (ex.length) entry.exclude = ex; else delete entry.exclude;
  }

  if (mode) {

    if (mode === "default") delete entry.mode;
    else if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}, default`);
    else entry.mode = mode;
  }

  await saveCfg(cfg);
  return entry;
}

export const statsPath = (dest, name) => path.join(dest, name, "stats.json");

async function loadStats(dest, name) {
  const raw = await readFile(statsPath(dest, name), "utf8").catch(() => null);
  if (raw) { try { return JSON.parse(raw); } catch {  } }
  return migrateStats(dest, name);
}

async function saveStats(dest, name, stats) {
  const target = statsPath(dest, name);
  const tmp = target + ".tmp";
  await writeFile(tmp, JSON.stringify(stats, null, 2) + "\n");
  await rename(tmp, target);
}

async function migrateStats(dest, name) {
  const dir = path.join(dest, name);
  const entries = await readdir(dir).catch(() => []);
  const stats = { snapshots: {} };
  let found = false;

  for (const f of entries) {
    if (!f.endsWith(".json") || f.endsWith(".files.json") || f === "stats.json") continue;
    const stamp = f.slice(0, -".json".length);
    const meta = await readFile(path.join(dir, f), "utf8").then(JSON.parse).catch(() => null);
    if (!meta) continue;
    found = true;
    const files = await readFile(path.join(dir, `${stamp}.files.json`), "utf8")
      .then(JSON.parse).catch(() => null);
    stats.snapshots[stamp] = { ...meta, ...(files ? { files } : {}) };
  }
  if (!found) return stats;

  await saveStats(dest, name, stats);

  for (const f of entries)
    if (f.endsWith(".json") && f !== "stats.json") await rm(path.join(dir, f), { force: true });
  return stats;
}

export async function readManifest(dest, name, stamp) {
  const stats = await loadStats(dest, name);
  const files = stats.snapshots?.[stamp]?.files;
  return files ? manifestToMap(files) : null;
}

export async function saveSnapshot(dest, name, stamp, { size, mtime, created, files }) {
  const stats = await loadStats(dest, name);
  stats.snapshots ||= {};
  stats.snapshots[stamp] = {
    size, mtime, created,
    ...(files ? { files: mapToManifest(files) } : {}),
  };
  await saveStats(dest, name, stats);
}

export async function dropSnapshot(dest, name, stamp) {
  const stats = await loadStats(dest, name);
  if (stats.snapshots?.[stamp]) { delete stats.snapshots[stamp]; await saveStats(dest, name, stats); }
}

export async function renameSnapshot(dest, name, from, to) {
  const stats = await loadStats(dest, name);
  if (!stats.snapshots?.[from]) return;
  stats.snapshots[to] = stats.snapshots[from];
  delete stats.snapshots[from];
  await saveStats(dest, name, stats);
}

export async function snapshotsFor(dest, name) {
  const dir = path.join(dest, name);
  const stats = await loadStats(dest, name);
  const rows = [];
  for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory()) continue;
    const snapDir = path.join(dir, ent.name);
    const s = await stat(snapDir).catch(() => null);
    if (!s) continue;
    const meta = stats.snapshots?.[ent.name];
    rows.push({
      stamp: ent.name,
      dir: snapDir,
      size: meta?.size ?? 0,
      mtime: new Date(meta?.mtime ?? s.mtime),
      created: meta?.created ?? meta?.mtime ?? new Date(s.mtime).toISOString(),
    });
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

export async function updateGlobalDataLog(cfg, events, ts) {
  if (!events.length) return;
  const dataFilePath = path.join(cfg.dest, "backly-data.txt");
  let totalSnapshots = 0;
  let totalVaultSize = 0;

  const trackedPathsReport = cfg.paths.map(e => `  - [${e.name}] -> ${shortHome(e.path)}`);

  const topEnts = await readdir(cfg.dest, { withFileTypes: true }).catch(() => []);
  for (const ent of topEnts) {
    if (ent.isDirectory()) {
      const pSnaps = await snapshotsFor(cfg.dest, ent.name);
      if (pSnaps.length > 0) {
        totalSnapshots += pSnaps.length;
        totalVaultSize += pSnaps.reduce((sum, s) => sum + s.size, 0);
      }
    }
  }

  const existingData = await readFile(dataFilePath, "utf8").catch(() => "");
  const logHeaderEnd = existingData.indexOf("── ACTIVITY LOG ──");
  const activityLog = logHeaderEnd !== -1 ? existingData.slice(logHeaderEnd) : "── ACTIVITY LOG ──\n";

  const telemetry = [
    "BACKLY VAULT DATA",
    "=".repeat(40),
    `Last Updated     : ${ts} (${new Date().toLocaleString()})`,
    `Total Snapshots  : ${totalSnapshots}`,
    `Total Vault Size : ${humanSize(totalVaultSize)} (${totalVaultSize} bytes)`,
    "",
    "Tracked Directories:",
    trackedPathsReport.length > 0 ? trackedPathsReport.join("\n") : "  (none registered)",
    "",
    activityLog.trim(),
    ...events.map((ev) => `[${ts}] ${ev.note ?? "BACKUP SUCCESS"}: ${ev.label} (${humanSize(ev.size ?? 0)})`),
  ];

  await writeFile(dataFilePath, telemetry.join("\n") + "\n");
}
