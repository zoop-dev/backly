
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, rm, rename, cp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stamp, humanSize, shortHome, expand, HOME } from "./ui.js";
import { exists, copyDir, syncDir, getDirSize, hasChanges, buildFileMap, isAbort, abortError } from "./engine.js";
import {
  loadCfg, saveCfg, driveStatus, editEntry, MODES, effectiveMode, readManifest, writeManifest, manifestPath,
  resolveStorage, snapshotsFor, updateGlobalDataLog,
} from "./vault.js";
import { scheduleStatus, scheduleOn, scheduleOff } from "./schedule.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

const listeners = new Set();
let job = null;
let controller = null;

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(frame);
}
function setJob(next) { job = next; broadcast("job", job); }
function logLine(text, level = "info") {
  broadcast("log", { text: stripAnsi(text), level, at: new Date().toISOString() });
}

async function buildState() {
  const cfg = await loadCfg();
  const drive = await driveStatus(cfg.dest);
  const names = new Set(cfg.paths.map((e) => e.name));
  for (const d of await readdir(cfg.dest, { withFileTypes: true }).catch(() => []))
    if (d.isDirectory()) names.add(d.name);

  const projects = [];
  for (const name of names) {
    const entry = cfg.paths.find((e) => e.name === name);
    const snaps = await snapshotsFor(cfg.dest, name);
    projects.push({
      name,
      path: entry?.path ?? null,
      shortPath: entry ? shortHome(entry.path) : null,
      orphan: !entry,
      missing: entry ? !(await exists(entry.path)) : false,
      exclude: entry?.exclude ?? [],
      mode: effectiveMode(cfg, entry),
      modeOwn: !!entry?.mode,
      totalBytes: snaps.reduce((s, x) => s + x.size, 0),
      snapshots: snaps.map((s) => ({
        stamp: s.stamp, size: s.size, human: humanSize(s.size),
        mtime: s.mtime.toISOString(), created: s.created,
      })),
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return {
    dest: cfg.dest, shortDest: shortHome(cfg.dest), exclude: cfg.exclude,
    defaultMode: cfg.mode ?? "snapshot",
    drive, projects, job,
    schedule: await scheduleStatus().catch(() => ({ installed: false, active: false })),
    totals: {
      projects: projects.length,
      snapshots: projects.reduce((s, p) => s + p.snapshots.length, 0),
      bytes: projects.reduce((s, p) => s + p.totalBytes, 0),
    },
  };
}

async function runBackup(target, signal) {
  const cfg = await loadCfg();
  const drv = await driveStatus(cfg.dest);
  if (drv.guarded && !drv.mounted) throw new Error(`backup drive not mounted: ${drv.mountpoint}`);

  const targets = target && target !== "all"
    ? cfg.paths.filter((e) => e.name === target)
    : cfg.paths;
  if (!targets.length) throw new Error(`nothing to back up for '${target}'`);

  await mkdir(cfg.dest, { recursive: true });
  const ts = stamp();
  const events = [];
  let done = 0, bumped = 0, mirrored = 0, failed = 0, totalBytes = 0;

  let cancelled = false;
  for (const e of targets) {
    if (signal?.aborted) { cancelled = true; break; }
    setJob({ ...job, target: e.name, message: `backing up ${e.name}` });
    if (!(await exists(e.path))) { logLine(`skipped ${e.name} — path missing`, "warn"); failed++; continue; }

    const projectDestDir = path.join(cfg.dest, e.name);
    const excludes = [...cfg.exclude, ...(e.exclude || [])];
    const snaps = await snapshotsFor(cfg.dest, e.name);

    if (snaps.length && effectiveMode(cfg, e) === "mirror") {
      let stats;
      try {
        stats = await syncDir(e.path, snaps[0].dir, excludes, (p) => {
          setJob({ ...job, target: e.name, message: `mirroring ${e.name}`, progress: p });
        }, signal, await readManifest(cfg.dest, e.name, snaps[0].stamp));
      } catch (err) {
        if (isAbort(err)) { logLine(`${e.name} mirror cancelled`, "warn"); cancelled = true; break; }
        logLine(`${e.name} sync failed: ${err.message}`, "error"); failed++; continue;
      }
      let dir = snaps[0].dir;
      if (snaps[0].stamp !== ts) {
        dir = path.join(projectDestDir, ts);
        try {
          await rename(snaps[0].dir, dir);
          await rm(path.join(projectDestDir, `${snaps[0].stamp}.json`), { force: true });
          await rm(manifestPath(cfg.dest, e.name, snaps[0].stamp), { force: true });
        } catch (err) { logLine(`${e.name} bump failed: ${err.message}`, "error"); failed++; continue; }
      }
      const size = await getDirSize(dir);
      await writeFile(path.join(projectDestDir, `${ts}.json`), JSON.stringify({
        size, mtime: new Date().toISOString(), created: snaps[0].created,
      }, null, 2) + "\n");
      await writeManifest(cfg.dest, e.name, ts, await buildFileMap(e.path, excludes));
      events.push({ label: `${e.name}/${ts}`, size, note: "MIRROR UPDATE" });
      totalBytes += size; mirrored++;
      logLine(`${e.name} mirrored — ${stats.copied} updated, ${stats.deleted} removed`, "ok");
      continue;
    }

    if (snaps.length) {
      if (!(await hasChanges(e.path, snaps[0].dir, excludes,
        await readManifest(cfg.dest, e.name, snaps[0].stamp)))) {
        if (snaps[0].stamp === ts) { logLine(`${e.name} unchanged`); bumped++; continue; }
        try {
          await rename(snaps[0].dir, path.join(projectDestDir, ts));
          await rm(path.join(projectDestDir, `${snaps[0].stamp}.json`), { force: true });
          await rename(manifestPath(cfg.dest, e.name, snaps[0].stamp),
            manifestPath(cfg.dest, e.name, ts)).catch(() => {});
          await writeFile(path.join(projectDestDir, `${ts}.json`), JSON.stringify({
            size: snaps[0].size, mtime: new Date().toISOString(), created: snaps[0].created,
          }, null, 2) + "\n");
        } catch (err) { logLine(`${e.name} bump failed: ${err.message}`, "error"); failed++; continue; }
        events.push({ label: `${e.name}/${ts}`, size: snaps[0].size, note: "TIMESTAMP BUMP (UNCHANGED)" });
        logLine(`${e.name} unchanged — timestamp bumped`);
        bumped++; continue;
      }
    }

    const snapshotDir = path.join(projectDestDir, ts);
    await mkdir(snapshotDir, { recursive: true });
    try {
      await copyDir(e.path, snapshotDir, excludes, (p) => {
        setJob({ ...job, target: e.name, message: `copying ${e.name}`, progress: p });
      }, signal);
    } catch (err) {

      await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      if (isAbort(err)) { logLine(`${e.name} cancelled — partial snapshot discarded`, "warn"); cancelled = true; break; }
      logLine(`${e.name} copy failed: ${err.message}`, "error");
      failed++; continue;
    }

    const size = await getDirSize(snapshotDir);
    const mtime = new Date().toISOString();
    await writeFile(path.join(projectDestDir, `${ts}.json`),
      JSON.stringify({ size, mtime, created: mtime }, null, 2) + "\n");
    await writeManifest(cfg.dest, e.name, ts, await buildFileMap(e.path, excludes));
    events.push({ label: `${e.name}/${ts}`, size });
    totalBytes += size; done++;
    logLine(`${e.name} saved — ${humanSize(size)}`, "ok");
  }

  await updateGlobalDataLog(cfg, events, ts);
  if (cancelled) throw abortError();
  return { done, bumped, mirrored, failed, bytes: totalBytes, human: humanSize(totalBytes) };
}

async function runRestore({ name, stamp: at, to }, signal) {
  const cfg = await loadCfg();
  const [entry] = await resolveStorage(cfg, name);
  const snaps = await snapshotsFor(cfg.dest, entry.name);
  if (!snaps.length) throw new Error(`no snapshots for ${entry.name}`);
  const snap = at ? snaps.find((s) => s.stamp === at) : snaps[0];
  if (!snap) throw new Error(`no snapshot ${at}`);

  const base = entry.path ? path.basename(entry.path) : entry.name;
  const parent = to ? path.resolve(expand(to)) : (entry.path ? path.dirname(entry.path) : null);
  if (!parent) throw new Error(`${entry.name} is unregistered — a destination is required`);
  const target = path.join(parent, base);

  logLine(`restoring ${entry.name} ${snap.stamp} → ${shortHome(target)}`, "warn");

  const staging = target + ".backly-restoring";
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  try {
    await copyDir(snap.dir, staging, [], (p) => {
      setJob({ ...job, target: entry.name, message: `restoring ${entry.name}`, progress: p });
    }, signal);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (isAbort(err)) logLine(`restore cancelled — ${shortHome(target)} left untouched`, "warn");
    throw err;
  }

  if (await exists(target)) await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  logLine(`restored ${entry.name} → ${shortHome(target)}`, "ok");
  return { restored: target };
}

async function runPrune({ name, keep }) {
  const cfg = await loadCfg();
  const targets = await resolveStorage(cfg, name);
  const k = Number.isInteger(keep) && keep >= 0 ? keep : 5;
  let removed = 0, freed = 0;
  for (const e of targets) {
    for (const s of (await snapshotsFor(cfg.dest, e.name)).slice(k)) {
      await rm(s.dir, { recursive: true, force: true });
      await rm(path.join(path.dirname(s.dir), `${s.stamp}.json`), { force: true }).catch(() => {});
      await rm(manifestPath(cfg.dest, e.name, s.stamp), { force: true }).catch(() => {});
      removed++; freed += s.size;
    }
  }
  if (removed) await updateGlobalDataLog(cfg,
    [{ label: `PRUNE (${removed} snapshots)`, size: freed, note: "STALE SNAPSHOTS PURGED" }], stamp());
  logLine(`pruned ${removed} snapshot(s), freed ${humanSize(freed)}`, "ok");
  return { removed, freed, human: humanSize(freed) };
}

async function runWipe({ name }) {
  const cfg = await loadCfg();
  if (name === "all") {
    for (const ent of await readdir(cfg.dest, { withFileTypes: true }).catch(() => []))
      await rm(path.join(cfg.dest, ent.name), { recursive: true, force: true });
    logLine("purged entire vault", "warn");
    return { wiped: "all" };
  }
  const targets = await resolveStorage(cfg, name);
  const wiped = [];
  for (const e of targets) {
    const dir = path.join(cfg.dest, e.name);
    if (!(await exists(dir))) continue;
    await rm(dir, { recursive: true, force: true });
    wiped.push({ label: `${e.name} (wiped vault)`, size: 0, note: "VAULT STORAGE WIPED" });
  }
  await updateGlobalDataLog(cfg, wiped, stamp());
  logLine(`wiped storage for ${name}`, "warn");
  return { wiped: name };
}

async function addPath({ path: raw, name, exclude, mode }) {
  const cfg = await loadCfg();
  const abs = path.resolve(expand(raw || ""));
  if (!raw) throw new Error("a path is required");
  if (!(await exists(abs))) throw new Error(`no such path: ${abs}`);
  const finalName = name || path.basename(abs);
  if (cfg.paths.some((e) => e.path === abs)) throw new Error(`already registered: ${abs}`);
  if (cfg.paths.some((e) => e.name === finalName)) throw new Error(`name '${finalName}' is taken`);
  const entry = { name: finalName, path: abs };
  const ex = (exclude || []).filter(Boolean);
  if (ex.length) entry.exclude = ex;
  if (mode && mode !== "default") {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}, default`);
    entry.mode = mode;
  }
  cfg.paths.push(entry);
  await saveCfg(cfg);
  logLine(`registered ${finalName}`, "ok");
  return entry;
}

async function runOnce({ path: raw, name, exclude }, signal) {
  const cfg = await loadCfg();
  const abs = path.resolve(expand(raw || ""));
  if (!raw) throw new Error("a path is required");
  if (!(await exists(abs))) throw new Error(`no such path: ${abs}`);
  const label = name || path.basename(abs);
  const ts = stamp();
  const excludes = [...cfg.exclude, ...(exclude || []).filter(Boolean)];
  const snapshotDir = path.join(cfg.dest, label, ts);
  await mkdir(snapshotDir, { recursive: true });
  try {
    await copyDir(abs, snapshotDir, excludes, (p) => {
      setJob({ ...job, target: label, message: `copying ${label}`, progress: p });
    }, signal);
  } catch (err) {
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const size = await getDirSize(snapshotDir);
  const mtime = new Date().toISOString();
  await writeFile(path.join(cfg.dest, label, `${ts}.json`),
    JSON.stringify({ size, mtime, created: mtime }, null, 2) + "\n");
  await writeManifest(cfg.dest, label, ts, await buildFileMap(abs, excludes));
  await updateGlobalDataLog(cfg, [{ label: `${label}/${ts} (one-time)`, size }], ts);
  logLine(`one-time snapshot of ${label} — ${humanSize(size)}`, "ok");
  return { name: label, size };
}

async function setDefaultMode({ mode }) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}`);
  const cfg = await loadCfg();
  cfg.mode = mode;
  await saveCfg(cfg);
  logLine(`default backup mode set to ${mode}`, "ok");
  return { defaultMode: mode };
}

async function setDest({ dir }) {
  if (!dir) throw new Error("a destination is required");
  const cfg = await loadCfg();
  cfg.dest = path.resolve(expand(dir));
  await saveCfg(cfg);
  await mkdir(cfg.dest, { recursive: true });
  logLine(`destination set to ${shortHome(cfg.dest)}`, "warn");
  return { dest: cfg.dest };
}

async function setExclude({ patterns }) {
  const cfg = await loadCfg();
  cfg.exclude = (patterns || []).map((x) => String(x).trim()).filter(Boolean);
  await saveCfg(cfg);
  logLine(`global excludes updated (${cfg.exclude.length})`, "ok");
  return { exclude: cfg.exclude };
}

async function editPath({ name, newName, path: newPath, exclude, mode }) {
  const cfg = await loadCfg();
  const entry = await editEntry(cfg, name, { newName, path: newPath, exclude, mode });
  logLine(`updated ${name}${newName && newName !== name ? ` → ${newName}` : ""}`, "ok");
  return entry;
}

async function setSchedule({ on, interval }) {
  const result = on ? await scheduleOn(interval) : await scheduleOff();
  logLine(on ? `auto-backup on — ${result.label}` : "auto-backup off", "ok");
  return await scheduleStatus();
}

async function removePath({ name }) {
  const cfg = await loadCfg();
  const before = cfg.paths.length;
  cfg.paths = cfg.paths.filter((e) => e.name !== name);
  if (cfg.paths.length === before) throw new Error(`not registered: ${name}`);
  await saveCfg(cfg);
  logLine(`unregistered ${name} (snapshots kept)`, "ok");
  return { removed: name };
}

const JOBS = { backup: runBackup, restore: runRestore, prune: runPrune, wipe: runWipe, once: runOnce };

async function startJob(kind, body) {
  if (job && job.status === "running") throw new Error("a job is already running");
  const id = randomBytes(6).toString("hex");
  controller = new AbortController();
  const { signal } = controller;
  setJob({ id, kind, target: body.name ?? body.target ?? "all", status: "running", message: `starting ${kind}`, progress: null, cancellable: kind === "backup" || kind === "restore" || kind === "once" });
  const fn = kind === "backup" ? () => runBackup(body.target, signal) : () => JOBS[kind](body, signal);
  fn()
    .then((result) => setJob({ ...job, status: "done", message: `${kind} complete`, progress: null, result }))
    .catch((err) => {
      if (isAbort(err)) return setJob({ ...job, status: "cancelled", message: `${kind} cancelled`, progress: null });
      logLine(err.message, "error");
      setJob({ ...job, status: "error", message: stripAnsi(err.message), progress: null });
    });
  return { started: id };
}

function cancelJob() {
  if (!job || job.status !== "running") throw new Error("nothing is running");
  if (!job.cancellable) throw new Error(`${job.kind} can't be cancelled`);
  controller?.abort();
  setJob({ ...job, message: `cancelling ${job.kind}…` });
  logLine(`cancel requested for ${job.kind}`, "warn");
  return { cancelling: job.id };
}

export function startServer({ port = 4849, token = randomBytes(16).toString("hex") } = {}) {
  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    const host = (req.headers.host || "").split(":")[0];
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host))
      return send(res, 403, { error: "forbidden host" });

    const supplied = req.headers["x-backly-token"] || url.searchParams.get("token");
    const authed = supplied === token;

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8").catch(() => null);
      if (!html) return send(res, 500, { error: "web assets missing" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (!authed) return send(res, 401, { error: "unauthorized" });

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); listeners.delete(res); });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state")
      return send(res, 200, await buildState().catch((e) => ({ error: stripAnsi(e.message) })));

    if (req.method === "GET" && url.pathname === "/api/browse") {
      const dir = path.resolve(expand(url.searchParams.get("path") || HOME));
      const ents = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!ents) return send(res, 400, { error: `can't read ${dir}` });
      const cfg = await loadCfg();
      const tracked = new Set(cfg.paths.map((e) => e.path));
      const entries = ents
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => {
          const full = path.join(dir, e.name);
          return { name: e.name, path: full, hidden: e.name.startsWith("."), tracked: tracked.has(full) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return send(res, 200, {
        path: dir, shortPath: shortHome(dir),
        parent: parent === dir ? null : parent,
        home: HOME, entries,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/vaultlog") {
      const cfg = await loadCfg();
      const raw = await readFile(path.join(cfg.dest, "backly-data.txt"), "utf8").catch(() => "");
      const at = raw.indexOf("── ACTIVITY LOG ──");
      const lines = (at === -1 ? "" : raw.slice(at))
        .split("\n").filter((l) => l.startsWith("[")).reverse().slice(0, 300);
      return send(res, 200, { lines });
    }

    if (req.method === "POST") {
      let body = {};
      try {
        const raw = await new Promise((resolve, reject) => {
          let d = ""; req.on("data", (x) => { d += x; if (d.length > 1e6) reject(new Error("body too large")); });
          req.on("end", () => resolve(d)); req.on("error", reject);
        });
        body = raw ? JSON.parse(raw) : {};
      } catch (e) { return send(res, 400, { error: e.message }); }

      const route = url.pathname.replace("/api/", "");
      try {
        if (route in JOBS) return send(res, 202, await startJob(route, body));
        if (route === "add") return send(res, 200, await addPath(body));
        if (route === "edit") return send(res, 200, await editPath(body));
        if (route === "remove") return send(res, 200, await removePath(body));
        if (route === "schedule") return send(res, 200, await setSchedule(body));
        if (route === "dest") return send(res, 200, await setDest(body));
        if (route === "mode") return send(res, 200, await setDefaultMode(body));
        if (route === "exclude") return send(res, 200, await setExclude(body));
        if (route === "cancel") return send(res, 200, cancelJob());
        return send(res, 404, { error: "not found" });
      } catch (e) { return send(res, 400, { error: stripAnsi(e.message) }); }
    }

    return send(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => {

    server.listen(port, "127.0.0.1", () => resolve({ server, port, token }));
  });
}
