
import { readFile, writeFile, mkdir, readdir, stat, rename } from "node:fs/promises";
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

export const manifestPath = (dest, name, stamp) => path.join(dest, name, `${stamp}.files.json`);

export async function readManifest(dest, name, stamp) {
  const raw = await readFile(manifestPath(dest, name, stamp), "utf8").catch(() => null);
  if (!raw) return null;
  try { return manifestToMap(JSON.parse(raw)); } catch { return null; }
}
export async function writeManifest(dest, name, stamp, map) {
  await writeFile(manifestPath(dest, name, stamp), JSON.stringify(mapToManifest(map)));
}

export async function snapshotsFor(dest, name) {
  const dir = path.join(dest, name);
  const tsDirs = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const ent of tsDirs) {
    if (!ent.isDirectory()) continue;
    const snapDir = path.join(dir, ent.name);
    const metaPath = path.join(dir, `${ent.name}.json`);
    const meta = await readFile(metaPath, "utf8").then(JSON.parse).catch(() => null);
    const s = await stat(snapDir).catch(() => null);
    if (!s) continue;
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
