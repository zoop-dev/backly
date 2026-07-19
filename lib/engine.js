
import { readdir, stat, lstat, access, cp, mkdir, rm } from "node:fs/promises";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

export const exists = (p) => access(p).then(() => true).catch(() => false);

export function matchesExclude(filePath, sourceDir, patterns) {
  const rel = path.relative(sourceDir, filePath);

  if (!rel) return false;
  const base = path.basename(filePath);
  return patterns.some((p) => {
    if (p.includes("/")) return rel === p || rel.startsWith(p + "/");
    if (p.startsWith("*")) return base.endsWith(p.slice(1));
    if (p.endsWith("*")) return base.startsWith(p.slice(0, -1));
    return base === p;
  });
}

export function sizeOf(p) {
  try { return statSync(p).size; }
  catch { try { return lstatSync(p).size; } catch { return 0; } }
}

function progressName(source, relDir) {
  const base = path.basename(source);
  if (!relDir || relDir === ".") return base;
  return `${base}/${relDir.length > 40 ? "…" + relDir.slice(-39) : relDir}`;
}

export function abortError() {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}
export const isAbort = (e) => e?.name === "AbortError";

export async function copyDir(source, dest, excludePats = [], onProgress = null, signal = null) {
  let totalFiles = 0;
  let totalBytes = 0;

  async function calcTotals(current) {
    if (signal?.aborted) throw abortError();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (matchesExclude(full, source, excludePats)) continue;
      if (ent.isDirectory()) {
        await calcTotals(full);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        totalFiles++;
        totalBytes += sizeOf(full);
      }
    }
  }
  await calcTotals(source);

  let copiedFiles = 0;
  let copiedBytes = 0;
  let currentDir = "";
  const startTime = Date.now();

  function emit() {
    if (!onProgress) return;
    const elapsed = Math.max(0.001, (Date.now() - startTime) / 1000);
    const bytesPerSec = copiedBytes / elapsed;
    const remainingBytes = Math.max(0, totalBytes - copiedBytes);
    onProgress({
      name: progressName(source, currentDir),
      percent: totalBytes > 0 ? Math.min(100, Math.floor((copiedBytes / totalBytes) * 100)) : 100,
      copiedBytes, totalBytes, copiedFiles, totalFiles,
      etaSec: bytesPerSec > 0 ? Math.ceil(remainingBytes / bytesPerSec) : 0,
    });
  }

  const timer = onProgress ? setInterval(emit, 100) : null;

  try {
    await cp(source, dest, {
      recursive: true,
      preserveTimestamps: true,

      dereference: true,
      filter: (src) => {
        if (signal?.aborted) throw abortError();
        const excluded = matchesExclude(src, source, excludePats);
        if (excluded) return false;
        try {
          if (!lstatSync(src).isDirectory()) {
            copiedFiles++;
            copiedBytes += sizeOf(src);

            currentDir = path.dirname(path.relative(source, src));
          }
        } catch {}
        return true;
      },
    });
  } finally {
    if (timer) clearInterval(timer);
    emit();
  }
}

export async function getDirSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      total += await getDirSize(full);
    } else {
      total += await lstat(full).then((s) => s.size).catch(() => 0);
    }
  }
  return total;
}

export async function buildFileMap(dir, excludePats) {
  const map = new Map();
  await walk(dir, "");
  return map;

  async function walk(current, relPrefix) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const full = path.join(current, ent.name);
      if (matchesExclude(full, dir, excludePats)) continue;
      if (ent.isDirectory()) {
        await walk(full, rel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {

        const s = await stat(full).catch(() => lstat(full).catch(() => null));
        if (s) map.set(rel, { size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
      }
    }
  }
}

async function pruneEmptyDirs(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    await pruneEmptyDirs(full);
    const left = await readdir(full).catch(() => ["keep"]);
    if (!left.length) await rm(full, { recursive: true, force: true });
  }
}

export async function syncDir(source, dest, excludePats = [], onProgress = null, signal = null, manifest = null) {
  const src = await buildFileMap(source, excludePats);
  const dst = await buildFileMap(dest, []);

  const toCopy = [];
  for (const [rel, info] of src) {
    const there = dst.get(rel);

    if (!there || there.size !== info.size) { toCopy.push(rel); continue; }
    const ref = manifest?.get(rel);
    if (ref ? ref.mtime !== info.mtime : Math.abs(there.mtime - info.mtime) > 2) toCopy.push(rel);
  }
  const toDelete = [...dst.keys()].filter((rel) => !src.has(rel));

  const totalFiles = toCopy.length;
  const totalBytes = toCopy.reduce((s, rel) => s + src.get(rel).size, 0);
  let copiedFiles = 0, copiedBytes = 0, currentDir = "";
  const startTime = Date.now();
  const emit = () => {
    if (!onProgress) return;
    const elapsed = Math.max(0.001, (Date.now() - startTime) / 1000);
    const rate = copiedBytes / elapsed;
    onProgress({
      name: progressName(source, currentDir),
      percent: totalBytes > 0 ? Math.min(100, Math.floor((copiedBytes / totalBytes) * 100)) : 100,
      copiedBytes, totalBytes, copiedFiles, totalFiles,
      etaSec: rate > 0 ? Math.ceil(Math.max(0, totalBytes - copiedBytes) / rate) : 0,
    });
  };
  emit();

  for (const rel of toCopy) {
    if (signal?.aborted) throw abortError();
    currentDir = path.dirname(rel);
    const to = path.join(dest, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(path.join(source, rel), to, { preserveTimestamps: true, dereference: true, force: true });
    copiedFiles++; copiedBytes += src.get(rel).size;
    emit();
  }
  for (const rel of toDelete) {
    if (signal?.aborted) throw abortError();
    await rm(path.join(dest, rel), { recursive: true, force: true });
  }
  await pruneEmptyDirs(dest);
  emit();

  return { copied: toCopy.length, deleted: toDelete.length, bytes: copiedBytes };
}

export function mapToManifest(map) {
  const o = {};
  for (const [k, v] of map) o[k] = [v.size, v.mtime];
  return o;
}
export function manifestToMap(o) {
  const m = new Map();
  for (const k of Object.keys(o || {})) m.set(k, { size: o[k][0], mtime: o[k][1] });
  return m;
}

export async function hasChanges(sourceDir, snapshotDir, excludePats = [], manifest = null) {
  const sourceMap = await buildFileMap(sourceDir, excludePats);
  const ref = manifest ?? await buildFileMap(snapshotDir, []);

  if (sourceMap.size !== ref.size) return true;

  for (const [relPath, info] of sourceMap) {
    const other = ref.get(relPath);
    if (!other) return true;
    if (info.size !== other.size) return true;

    if (manifest ? info.mtime !== other.mtime : Math.abs(info.mtime - other.mtime) > 2) return true;
  }

  return false;
}
