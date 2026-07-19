#!/usr/bin/env node

import { writeFile, mkdir, readdir, rm, rename, cp } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  c, ok, dot, banner, header, die, confirm,
  expand, shortHome, stamp, humanSize, timeAgo, HOME, terminalProgress, tty, pick, ask,
} from "../lib/ui.js";
import { exists, copyDir, syncDir, getDirSize, hasChanges, buildFileMap } from "../lib/engine.js";
import {
  loadCfg, saveCfg, driveStatus, editEntry, MODES, effectiveMode, readManifest, writeManifest, manifestPath,
  resolveEntries, resolveStorage, snapshotsFor, updateGlobalDataLog,
} from "../lib/vault.js";
import { scheduleStatus, scheduleOn, scheduleOff } from "../lib/schedule.js";
import {
  installRoot, isDevCheckout, findLinks, checkUpdate, applyUpdate, removeInstall, currentVersion,
} from "../lib/selfupdate.js";
import { CFG_DIR } from "../lib/vault.js";

async function pickProject(cfg, label = "tracked folders") {
  if (!tty || !cfg.paths.length) return null;
  const { item } = await pick(label, cfg.paths, {
    name: (e) => e.name,
    render: (e) => c.bold(e.name.padEnd(18)) + c.dim(shortHome(e.path)) +
      (effectiveMode(cfg, e) === "mirror" ? c.mag("  [mirror]") : ""),
    prompt: "Which folder (number, or name)",
  });
  return item?.name ?? null;
}

async function cmdAdd(rawPath, ...rest) {
  if (!rawPath) die("usage: " + c.cyan("backly add <path> [--name <n>] [--mode snapshot|mirror] [--exclude <pat>…]"));
  const cfg = await loadCfg();
  const abs = path.resolve(expand(rawPath));
  if (!(await exists(abs))) die("no such path: " + c.cyan(abs));
  let name = null, mode = null;
  const exclude = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name" || rest[i] === "-n") name = rest[++i];
    else if (rest[i] === "--mode" || rest[i] === "-m") mode = rest[++i];
    else if (rest[i] === "--exclude" || rest[i] === "-x") exclude.push(rest[++i]);
  }
  name ||= path.basename(abs);
  if (mode && mode !== "default" && !MODES.includes(mode)) die(`mode must be one of: ${MODES.join(", ")}, default`);
  if (cfg.paths.some((e) => e.path === abs)) die("already registered: " + c.cyan(abs));
  if (cfg.paths.some((e) => e.name === name)) die(`name '${name}' is taken — pass ${c.cyan("--name <other>")}.`);
  const entry = { name, path: abs };
  if (exclude.length) entry.exclude = exclude;
  if (mode && mode !== "default") entry.mode = mode;
  cfg.paths.push(entry);
  await saveCfg(cfg);
  header("registered " + c.br(name));
  console.log("    " + dot + c.dim(" " + shortHome(abs)) +
    c.grey("   " + effectiveMode(cfg, entry) + " mode" + (entry.mode ? "" : " (default)")) +
    (exclude.length ? c.grey("   skips " + exclude.join(" ")) : "") + "\n");
}

async function cmdRemove(token) {
  const cfg = await loadCfg();
  if (!token) {
    header("stop tracking a folder"); console.log();
    token = await pickProject(cfg);
    if (!token) die("usage: " + c.cyan("backly rm <path|name>"));
  }
  const before = cfg.paths.length;
  const abs = path.resolve(expand(token));
  cfg.paths = cfg.paths.filter((e) => !(e.name === token || e.path === abs));
  if (cfg.paths.length === before) die(`not registered: '${token}'.`);
  await saveCfg(cfg);
  header("unregistered " + c.br(token));
  console.log("    " + c.dim("(its existing snapshots are kept)") + "\n");
}

async function cmdList() {
  const cfg = await loadCfg();
  header("tracked paths  " + c.dim("· " + shortHome(cfg.dest)));
  console.log();
  if (!cfg.paths.length) { console.log("    " + c.dim("nothing yet — ") + c.cyan("backly add <path>") + "\n"); return; }
  for (const e of cfg.paths) {
    const snaps = await snapshotsFor(cfg.dest, e.name);
    const last = snaps[0];
    const missing = !(await exists(e.path));
    console.log("    " + (missing ? c.red("∅") : c.br("∩")) + " " + c.bold(e.name.padEnd(16)) +
      c.dim(shortHome(e.path).padEnd(34)) +
      (snaps.length
        ? c.grey(`${snaps.length} snap${snaps.length > 1 ? "s" : ""}`) + c.dim(`  last ${timeAgo(last.mtime.toISOString())} ago · ${humanSize(last.size)}`)
        : c.dim("no snapshots")) +
      (effectiveMode(cfg, e) === "mirror" ? "  " + c.mag("[mirror]") + (e.mode ? "" : c.dim("*")) : "") +
      (missing ? "  " + c.red("(path missing)") : ""));
  }
  console.log();
}

async function cmdBackup(token) {
  const cfg = await loadCfg();
  const targets = resolveEntries(cfg, token);
  const drv = await driveStatus(cfg.dest);
  if (drv.guarded && !drv.mounted)
    die("backup drive not mounted: " + c.cyan(drv.mountpoint) + "\n    plug it in, or point elsewhere with " + c.cyan("backly dest <dir>") + ".");

  await mkdir(cfg.dest, { recursive: true });
  const ts = stamp();
  let done = 0, bumped = 0, mirrored = 0, totalBytes = 0;
  const events = [];

  for (const e of targets) {
    header(`backup ${c.br(e.name)} ${c.dim("→ " + ts)}`);
    if (!(await exists(e.path))) { console.log("    " + c.yellow("! skipped — path missing: ") + c.dim(shortHome(e.path))); continue; }

    const projectDestDir = path.join(cfg.dest, e.name);
    const excludes = [...cfg.exclude, ...(e.exclude || [])];
    const snaps = await snapshotsFor(cfg.dest, e.name);

    if (snaps.length > 0 && effectiveMode(cfg, e) === "mirror") {
      const target = snaps[0].dir;
      let stats;
      const prog = terminalProgress();
      const man = await readManifest(cfg.dest, e.name, snaps[0].stamp);
      try { stats = await syncDir(e.path, target, excludes, prog.onProgress, null, man); }
      catch (err) { console.log("    " + c.yellow("! sync failed: ") + c.dim(err.message)); continue; }
      finally { prog.finish(); }

      let dir = target;
      if (snaps[0].stamp !== ts) {
        dir = path.join(projectDestDir, ts);
        try {
          await rename(target, dir);
          await rm(path.join(projectDestDir, `${snaps[0].stamp}.json`), { force: true });
          await rm(manifestPath(cfg.dest, e.name, snaps[0].stamp), { force: true });
        } catch (err) { console.log("    " + c.yellow("! bump failed: ") + c.dim(err.message)); continue; }
      }
      const size = await getDirSize(dir);
      await writeFile(path.join(projectDestDir, `${ts}.json`), JSON.stringify({
        size, mtime: new Date().toISOString(), created: snaps[0].created,
      }, null, 2) + "\n");
      await writeManifest(cfg.dest, e.name, ts, await buildFileMap(e.path, excludes));
      events.push({ label: `${e.name}/${ts}`, size, note: "MIRROR UPDATE" });
      totalBytes += size; mirrored++;
      console.log("    " + ok + c.green("  mirrored ") +
        c.dim(`${stats.copied} updated · ${stats.deleted} removed · `) + c.grey(humanSize(size)));
      continue;
    }

    if (snaps.length > 0) {
      const latestSnapshot = snaps[0].dir;
      const changed = await hasChanges(e.path, latestSnapshot, excludes,
        await readManifest(cfg.dest, e.name, snaps[0].stamp));

      if (!changed) {
        bumped++;
        if (snaps[0].stamp === ts) {
          console.log("    " + ok + c.green("  unchanged ") + c.dim("— snapshot already at current timestamp"));
          continue;
        }
        const newSnapshotDir = path.join(projectDestDir, ts);
        const oldMetaPath = path.join(projectDestDir, `${snaps[0].stamp}.json`);
        const newMetaPath = path.join(projectDestDir, `${ts}.json`);
        try {
          await rename(latestSnapshot, newSnapshotDir);
          await rename(manifestPath(cfg.dest, e.name, snaps[0].stamp),
            manifestPath(cfg.dest, e.name, ts)).catch(() => {});

          await rm(oldMetaPath, { force: true });
          await writeFile(newMetaPath, JSON.stringify({
            size: snaps[0].size,
            mtime: new Date().toISOString(),
            created: snaps[0].created,
          }, null, 2) + "\n");
        } catch (err) {
          console.log("    " + c.yellow("! bump failed: ") + c.dim(err.message));
          continue;
        }
        events.push({ label: `${e.name}/${ts}`, size: snaps[0].size, note: "TIMESTAMP BUMP (UNCHANGED)" });
        console.log("    " + ok + c.green("  unchanged ") + c.dim("— snapshot timestamp bumped to current clock"));
        continue;
      }
    }

    const snapshotDir = path.join(projectDestDir, ts);
    await mkdir(snapshotDir, { recursive: true });

    try {
      const prog = terminalProgress();
      try { await copyDir(e.path, snapshotDir, excludes, prog.onProgress); }
      finally { prog.finish(); }
    } catch (err) {
      await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      console.log("    " + c.yellow("! skipped — copy failed: ") + c.dim(err.message));
      continue;
    }

    const size = await getDirSize(snapshotDir);
    const mtime = new Date().toISOString();
    await writeFile(path.join(projectDestDir, `${ts}.json`), JSON.stringify({ size, mtime, created: mtime }, null, 2) + "\n");
    await writeManifest(cfg.dest, e.name, ts, await buildFileMap(e.path, excludes));
    events.push({ label: `${e.name}/${ts}`, size });
    totalBytes += size; done++;

    console.log("    " + dot + c.dim(" saved snapshot ") + c.cyan(shortHome(snapshotDir)) + c.grey("  " + humanSize(size)));
  }

  await updateGlobalDataLog(cfg, events, ts);

  let summary = `\n  ${ok} ${c.green(c.bold(` ${done} snapshot${done !== 1 ? "s" : ""} saved`))}`;
  if (mirrored > 0) summary += c.dim(`  ·  ${mirrored} mirrored`);
  if (bumped > 0) summary += c.dim(`  ·  ${bumped} bumped (unchanged)`);
  summary += c.dim(`  ·  ${humanSize(totalBytes)}  ·  ${shortHome(cfg.dest)}\n`);
  console.log(summary);
}

async function cmdOnce(rawPath, ...rest) {
  if (!rawPath) die("usage: " + c.cyan("backly once <path> [--name <name>] [--exclude <pat>…]"));

  const cfg = await loadCfg();
  const abs = path.resolve(expand(rawPath));
  if (!(await exists(abs))) die("no such path: " + c.cyan(abs));

  let name = null, mode = null;
  const exclude = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name" || rest[i] === "-n") name = rest[++i];
    else if (rest[i] === "--mode" || rest[i] === "-m") mode = rest[++i];
    else if (rest[i] === "--exclude" || rest[i] === "-x") exclude.push(rest[++i]);
  }
  name ||= path.basename(abs);
  if (mode && mode !== "default" && !MODES.includes(mode)) die(`mode must be one of: ${MODES.join(", ")}, default`);

  const drv = await driveStatus(cfg.dest);
  if (drv.guarded && !drv.mounted) die("backup drive not mounted: " + c.cyan(drv.mountpoint));

  await mkdir(cfg.dest, { recursive: true });
  const ts = stamp();
  header(`one-time backup ${c.br(name)} ${c.dim("→ " + ts)}`);

  const snapshotDir = path.join(cfg.dest, name, ts);
  await mkdir(snapshotDir, { recursive: true });

  const excludes = [...cfg.exclude, ...exclude];

  const prog = terminalProgress();
  try {
    await copyDir(abs, snapshotDir, excludes, prog.onProgress);
  } catch (err) {
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    die("one-time backup failed: " + err.message);
  } finally {
    prog.finish();
  }

  const size = await getDirSize(snapshotDir);
  const mtime = new Date().toISOString();
  await writeFile(path.join(cfg.dest, name, `${ts}.json`), JSON.stringify({ size, mtime, created: mtime }, null, 2) + "\n");
  await writeManifest(cfg.dest, name, ts, await buildFileMap(abs, excludes));
  await updateGlobalDataLog(cfg, [{ label: `${name}/${ts} (one-time)`, size }], ts);

  console.log("    " + dot + " " + c.cyan(shortHome(snapshotDir)) + c.grey("  " + humanSize(size)));
  console.log("\n  " + ok + c.green(c.bold("  1 temporary snapshot saved")) + c.dim(`  ·  ${humanSize(size)}  ·  ${shortHome(cfg.dest)}`) + "\n");
}

async function cmdSnapshots(token) {
  const cfg = await loadCfg();
  const targets = await resolveStorage(cfg, token);
  for (const e of targets) {
    const snaps = await snapshotsFor(cfg.dest, e.name);
    header(`snapshots ${c.br(e.name)} ${c.dim("· " + snaps.length)}` +
      (e.orphan ? c.yellow("  (unregistered)") : ""));
    console.log();
    if (!snaps.length) { console.log("    " + c.dim("none yet — ") + c.cyan("backly backup " + e.name) + "\n"); continue; }
    for (const s of snaps)
      console.log("    " + dot + " " + c.bold(s.stamp) +
        c.dim("   " + timeAgo(s.mtime.toISOString()).padStart(4) + " ago") + c.grey("   " + humanSize(s.size)));
    console.log();
  }
}

async function cmdRestore(token, ...rest) {
  const cfg = await loadCfg();
  if (!token) {
    header("restore a folder"); console.log();
    token = await pickProject(cfg);
    if (!token) die("usage: " + c.cyan("backly restore <name> [--at <stamp>] [--to <dir>]"));
  }
  const [e] = resolveEntries(cfg, token);
  const snaps = await snapshotsFor(cfg.dest, e.name);
  if (!snaps.length) die("no snapshots for " + c.br(e.name) + ".");
  let at = null, to = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--at") at = rest[++i];
    else if (rest[i] === "--to") to = rest[++i];
  }

  if (!at && snaps.length > 1 && tty) {
    header(`snapshots of ${c.br(e.name)}`); console.log();
    const { item } = await pick("available snapshots", snaps, {
      name: (s) => s.stamp,
      render: (s, i) => c.bold(s.stamp) + c.dim("   " + timeAgo(s.mtime.toISOString()).padStart(4) + " ago") +
        c.grey("   " + humanSize(s.size)),
      prompt: "Restore which snapshot (number, or stamp)",
    });
    if (!item) { console.log("    " + c.dim("aborted.") + "\n"); return; }
    at = item.stamp;
  }
  const snap = at ? snaps.find((s) => s.stamp.includes(at)) : snaps[0];
  if (!snap) die("no snapshot matching " + c.cyan(at) + ".");
  const dest = path.resolve(expand(to || path.dirname(e.path)));
  const restoreTarget = path.join(dest, path.basename(e.path));
  header(`restore ${c.br(e.name)} ${c.dim("→ " + shortHome(restoreTarget))}`);
  console.log("    " + dot + c.dim(" from snapshot ") + c.cyan(snap.stamp) + c.grey("  " + humanSize(snap.size)));
  if (!(await confirm("replace folder at " + shortHome(restoreTarget) + "?", true))) return void console.log("    " + c.dim("aborted.") + "\n");

  try {
    if (await exists(restoreTarget)) {
      await rm(restoreTarget, { recursive: true, force: true });
    }
    await cp(snap.dir, restoreTarget, { recursive: true, preserveTimestamps: true });
  } catch (err) {
    die("restore failed: " + err.message);
  }
  console.log("\n  " + ok + c.green("  restored") + c.dim("  → " + shortHome(restoreTarget)) + "\n");
}

async function cmdPrune(token, ...rest) {
  const cfg = await loadCfg();
  const targets = await resolveStorage(cfg, token);
  let keep = 5;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--keep" && rest[i] !== "-k") continue;

    const n = parseInt(rest[++i]);
    if (Number.isInteger(n) && n >= 0) keep = n;
  }
  let removed = 0, freed = 0;
  for (const e of targets) {
    const snaps = await snapshotsFor(cfg.dest, e.name);
    const stale = snaps.slice(keep);
    if (!stale.length) continue;
    header(`prune ${c.br(e.name)} ${c.dim("· keep " + keep)}`);
    for (const s of stale) {
      const metaPath = path.join(path.dirname(s.dir), `${s.stamp}.json`);
      await rm(s.dir, { recursive: true, force: true });
      await rm(metaPath, { force: true }).catch(() => {});
      await rm(manifestPath(cfg.dest, e.name, s.stamp), { force: true }).catch(() => {});
      removed++; freed += s.size;
      console.log("    " + c.red("− ") + c.dim(s.stamp) + c.grey("  " + humanSize(s.size)));
    }
  }
  if (removed > 0)
    await updateGlobalDataLog(cfg, [{ label: `PRUNE (${removed} snapshots)`, size: freed, note: "STALE SNAPSHOTS PURGED" }], stamp());
  console.log("\n  " + ok + c.dim(`  removed ${removed} old snapshot${removed !== 1 ? "s" : ""} · freed ${humanSize(freed)}`) + "\n");
}

async function cmdWipe(token) {
  const cfg = await loadCfg();
  if (!token) {
    header("wipe stored snapshots"); console.log();
    token = await pickProject(cfg, "stored folders");
    if (!token) die("usage: " + c.cyan("backly wipe <name|all>"));
  }

  const targets = await resolveStorage(cfg, token);
  const targetLabel = token === "all" ? c.red(c.bold("EVERYTHING")) : c.br(token);

  header(`wipe storage ${targetLabel}`);
  const confirmMsg = token === "all"
    ? `completely erase ALL snapshots and metrics inside ${shortHome(cfg.dest)}?`
    : `completely erase all snapshots inside ${shortHome(path.join(cfg.dest, targets[0].name))}?`;

  if (!(await confirm(confirmMsg, false))) {
    console.log("    " + c.dim("aborted."));
    return;
  }

  if (token === "all") {

    const topEnts = await readdir(cfg.dest, { withFileTypes: true }).catch(() => []);
    for (const ent of topEnts) {
      const fullPath = path.join(cfg.dest, ent.name);
      await rm(fullPath, { recursive: true, force: true });
    }
    console.log("    " + ok + c.red("  purged entire vault directory ") + c.dim(shortHome(cfg.dest)));
  } else {

    const wiped = [];
    for (const e of targets) {
      const projectDestDir = path.join(cfg.dest, e.name);
      if (!(await exists(projectDestDir))) { console.log("    " + c.dim(`no storage path for ${e.name}`)); continue; }
      await rm(projectDestDir, { recursive: true, force: true });
      wiped.push({ label: `${e.name} (wiped vault)`, size: 0, note: "VAULT STORAGE WIPED" });
      console.log("    " + ok + c.red("  purged physical directory ") + c.dim(shortHome(projectDestDir)));
    }
    await updateGlobalDataLog(cfg, wiped, stamp());
  }
  console.log();
}

async function cmdSize(token) {
  const cfg = await loadCfg();
  const targets = await resolveStorage(cfg, token);
  header("vault distribution sizes");
  console.log();

  let combinedBytes = 0;
  for (const e of targets) {
    const snaps = await snapshotsFor(cfg.dest, e.name);
    const totalBytes = snaps.reduce((sum, s) => sum + s.size, 0);
    combinedBytes += totalBytes;

    const nameStr = e.name.padEnd(18);
    const countStr = `${snaps.length} archive${snaps.length !== 1 ? "s" : ""}`.padEnd(14);
    const sizeStr = c.cyan(humanSize(totalBytes));

    console.log("    " + dot + " " + c.bold(nameStr) + c.grey(countStr) + sizeStr);
  }
  console.log("\n  " + ok + c.dim("  Combined raw size across target segments: ") + c.cyan(c.bold(humanSize(combinedBytes))) + "\n");
}

async function cmdDest(newDir) {
  const cfg = await loadCfg();
  if (!newDir) { header("backup destination"); console.log("\n    " + dot + " " + c.cyan(shortHome(cfg.dest)) + "\n"); return; }
  cfg.dest = path.resolve(expand(newDir));
  await saveCfg(cfg);
  await mkdir(cfg.dest, { recursive: true });
  header("destination set"); console.log("\n    " + dot + " " + c.cyan(shortHome(cfg.dest)) + "\n");
}

async function cmdExclude(action, ...pats) {
  const cfg = await loadCfg();
  if (action === "add") { for (const p of pats) if (!cfg.exclude.includes(p)) cfg.exclude.push(p); await saveCfg(cfg); }
  else if (action === "rm" || action === "remove") { cfg.exclude = cfg.exclude.filter((p) => !pats.includes(p)); await saveCfg(cfg); }
  else if (action && action !== "list") die("usage: " + c.cyan("backly exclude [add|rm <pattern…>]"));
  header("exclude patterns"); console.log();
  for (const p of cfg.exclude) console.log("    " + c.grey("✕ ") + p);
  console.log();
}

async function cmdAuto(action, ...rest) {
  if (!action || action === "status") {
    const st = await scheduleStatus();
    header("auto-backup");
    console.log();
    if (!st.installed) { console.log("    " + c.yellow("○ off") + c.dim("  — turn on with ") + c.cyan("backly auto on [interval]") + "\n"); return; }
    console.log("    " + (st.active ? ok + " " + c.green("on") : c.yellow("○ off")) +
      (st.interval ? c.dim("  · " + st.interval) : ""));
    if (st.next) console.log("    " + c.dim("next: " + st.next));
    console.log("    " + c.dim("dest: ") + c.cyan(shortHome((await loadCfg()).dest)) + "\n");
    return;
  }

  if (action === "off") {
    await scheduleOff();
    header("auto-backup off"); console.log("\n    " + dot + c.dim(" schedule removed") + "\n"); return;
  }

  if (action === "on") {
    let raw = rest.find((a) => !a.startsWith("-"));
    for (let i = 0; i < rest.length; i++) if (rest[i] === "--every" || rest[i] === "-e") raw = rest[++i];
    if (!raw && tty) {
      header("auto-backup");
      console.log();
      const choices = ["hourly", "daily", "weekly", "6h", "30m"];
      const { item, key } = await pick("how often to run", choices, {
        render: (x) => c.bold(x.padEnd(8)) + c.dim({
          hourly: "every hour", daily: "once a day, at midnight", weekly: "once a week",
          "6h": "every 6 hours", "30m": "every 30 minutes",
        }[x]),
        extra: { c: "something else (e.g. 2d, 90m)" },
        prompt: "Pick a schedule (number, or name)",
      });
      raw = key === "c" ? await ask("Interval", { required: true }) : item;
      if (!raw) return;
    }
    const iv = await scheduleOn(raw).catch((e) => die(e.message));
    header("auto-backup on");
    console.log("    " + dot + c.dim(" runs ") + c.br(iv.label) + c.dim(" → ") + c.cyan(shortHome((await loadCfg()).dest)));
    console.log("    " + c.dim("   missed runs (drive unplugged) catch up on next login"));
    console.log("    " + c.dim("   to run while logged out: ") + c.cyan("loginctl enable-linger") + "\n");
    return;
  }
  die("usage: " + c.cyan("backly auto [on [interval] | off | status]"));
}

async function cmdEdit(name, ...rest) {
  const cfg = await loadCfg();
  if (!name) {
    header("edit a tracked folder"); console.log();
    name = await pickProject(cfg);
    if (!name) die("usage: " + c.cyan("backly edit <name> [--name <new>] [--path <dir>] [--mode snapshot|mirror] [--exclude <pat>…]"));
  }
  const patch = {};
  const exclude = [];
  let sawExclude = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name" || rest[i] === "-n") patch.newName = rest[++i];
    else if (rest[i] === "--path" || rest[i] === "-p") patch.path = rest[++i];
    else if (rest[i] === "--mode" || rest[i] === "-m") patch.mode = rest[++i];
    else if (rest[i] === "--exclude" || rest[i] === "-x") { sawExclude = true; exclude.push(rest[++i]); }
    else if (rest[i] === "--no-exclude") sawExclude = true;
  }
  if (sawExclude) patch.exclude = exclude;
  const entry = await editEntry(cfg, name, patch);
  header("updated " + c.br(entry.name));
  console.log("    " + dot + c.dim(" " + shortHome(entry.path)) +
    c.grey("   " + effectiveMode(cfg, entry) + " mode" + (entry.mode ? "" : " (default)")) +
    (entry.exclude?.length ? c.grey("   skips " + entry.exclude.join(" ")) : "") + "\n");
}

async function cmdMode(value) {
  const cfg = await loadCfg();
  if (!value) {
    header("default backup mode");
    console.log("\n    " + dot + " " + c.br(cfg.mode) +
      c.dim(cfg.mode === "mirror"
        ? "   one folder kept in sync"
        : "   a new snapshot per change"));
    const overrides = cfg.paths.filter((e) => e.mode);
    if (overrides.length) {
      console.log("\n    " + c.dim("overridden per project:"));
      for (const e of overrides) console.log("      " + c.grey(e.name.padEnd(18)) + c.mag(e.mode));
    }
    if (!tty) { console.log("\n    " + c.dim("set with ") + c.cyan("backly mode <snapshot|mirror>") + "\n"); return; }
    console.log();
    const { item } = await pick("backup modes", MODES, {
      render: (m) => c.bold(m.padEnd(9)) + c.dim(m === "mirror"
        ? "one folder kept continuously in sync"
        : "a new snapshot each time something changes") +
        (m === cfg.mode ? c.grey("  · current") : ""),
      prompt: "Set the default mode (number, or name)",
    });
    if (!item || item === cfg.mode) { console.log("    " + c.dim("unchanged.") + "\n"); return; }
    value = item;
  }
  if (!MODES.includes(value)) die(`mode must be one of: ${MODES.join(", ")}`);
  cfg.mode = value;
  await saveCfg(cfg);
  const inherit = cfg.paths.filter((e) => !e.mode).length;
  header("default mode set");
  console.log("\n    " + dot + " " + c.br(value) +
    c.dim(`   applies to ${inherit} project${inherit === 1 ? "" : "s"} without their own mode`) + "\n");
}

async function cmdVersion() {
  const [v, root] = await Promise.all([currentVersion(), installRoot()]);
  const dev = await isDevCheckout(root);
  console.log("\n  " + c.bold(c.br("backly")) + " " + c.bold("v" + v) +
    (dev ? c.dim("  (working copy)") : ""));
  console.log("  " + c.dim("node ") + c.grey(process.version) +
    c.dim("  ·  ") + c.grey(shortHome(root)) + "\n");
}

async function cmdUpdate(...rest) {
  const force = rest.includes("--force") || rest.includes("-f");
  const root = await installRoot();
  header("update backly");
  console.log("\n    " + dot + c.dim(" installed at ") + c.cyan(shortHome(root)));

  if (await isDevCheckout(root)) {
    console.log("    " + c.yellow("! this looks like a working copy, not an install"));
    console.log("    " + c.dim("   updating would overwrite your local source with the published build."));
    console.log("    " + c.dim("   use ") + c.cyan("git pull") + c.dim(" here instead.\n"));
    if (!force) return;
    if (!(await confirm("overwrite this working copy anyway?", false))) return;
  }

  let res;
  try { res = await checkUpdate(); }
  catch (err) { die(err.message); }

  if (!res.changed.length) {
    await rm(res.staged, { recursive: true, force: true }).catch(() => {});
    console.log("    " + ok + c.green("  already up to date") + "\n");
    return;
  }
  console.log("    " + dot + c.dim(` ${res.changed.length} file(s) differ:`));
  for (const f of res.changed.slice(0, 8)) console.log("      " + c.grey(f));
  if (res.changed.length > 8) console.log("      " + c.dim(`… and ${res.changed.length - 8} more`));

  if (!(await confirm("install the new version?", true))) {
    await rm(res.staged, { recursive: true, force: true }).catch(() => {});
    console.log("    " + c.dim("aborted.") + "\n");
    return;
  }
  await applyUpdate(res.staged, res.root);
  header("updated");
  console.log("    " + ok + c.green(`  ${res.changed.length} file(s) updated`) + c.dim("  · run ") + c.cyan("backly help") + "\n");
}

async function cmdUninstall(...rest) {
  const root = await installRoot();
  const links = await findLinks(root);
  const cfg = await loadCfg();
  header("uninstall backly");
  console.log("\n    " + dot + c.dim(" install:  ") + c.cyan(shortHome(root)));
  console.log("    " + dot + c.dim(" command:  ") + (links.length ? c.cyan(links.map(shortHome).join(", ")) : c.grey("none found")));
  console.log("    " + dot + c.dim(" config:   ") + c.cyan(shortHome(CFG_DIR)));
  console.log("    " + dot + c.dim(" backups:  ") + c.cyan(shortHome(cfg.dest)) + c.green("   (kept)"));

  if (await isDevCheckout(root)) {
    console.log("\n    " + c.yellow("! this is a working copy — refusing to delete it"));
    console.log("    " + c.dim("   remove the ") + c.cyan("backly") + c.dim(" symlink by hand, or ") +
      c.cyan("npm unlink -g backly") + c.dim(".\n"));
    return;
  }

  const sched = await scheduleStatus().catch(() => ({ installed: false }));
  if (sched.installed) console.log("    " + dot + c.dim(" schedule: ") + c.cyan("will be disabled"));

  console.log();
  if (!(await confirm("remove backly?", false))) { console.log("    " + c.dim("aborted.") + "\n"); return; }
  const alsoConfig = await confirm("also delete settings (tracked folders, excludes)?", false);

  if (sched.installed) await scheduleOff().catch(() => {});
  await removeInstall({ root, links, removeConfig: alsoConfig, configDir: CFG_DIR });

  header("uninstalled");
  console.log("    " + ok + c.dim("  removed ") + shortHome(root));
  if (alsoConfig) console.log("    " + ok + c.dim("  removed settings"));
  console.log("    " + dot + c.green("  your backups are untouched: ") + c.cyan(shortHome(cfg.dest)));

  const shell = path.basename(process.env.SHELL || "");
  if (shell !== "fish") {
    const cmd = /^(t?csh)$/.test(shell) ? "rehash" : "hash -r";
    console.log("\n    " + dot + c.dim(" your shell still has ") + c.cyan("backly") +
      c.dim(" cached — clear it with:"));
    console.log("        " + c.cyan(cmd));
  }
  console.log();
}

async function cmdWeb(...rest) {
  let port = 4849;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port" || rest[i] === "-p") {
      const n = parseInt(rest[++i]);
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    }
  }
  const { startServer } = await import("../lib/server.js");
  const { token } = await startServer({ port }).catch((e) => die("couldn't start server: " + e.message));
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  header("control panel");
  console.log("\n    " + dot + " " + c.cyan(url));
  console.log("    " + c.dim("   bound to 127.0.0.1 only · the token is required for every action"));
  console.log("    " + c.dim("   this panel can restore and delete folders — don't share the link"));
  console.log("\n  " + c.dim("  ctrl-c to stop") + "\n");

  await new Promise(() => {});
}

async function help() {
  banner(await currentVersion().catch(() => ""));
  const row = (cmd, desc) => "    " + c.cyan(cmd) + " ".repeat(Math.max(2, 34 - cmd.length)) + c.dim(desc);
  const section = (title, rows) => { console.log("\n  " + c.br("▸ ") + c.bold(title)); rows.forEach(([a, b]) => console.log(row(a, b))); };
  console.log("  " + c.dim("usage  ") + c.bold("backly") + c.dim(" <command> [args]"));
  console.log("  " + c.grey("─".repeat(48)));
  section("set up", [
    ["add <path> [--name n] [--mode m]", "track a path (mode: snapshot | mirror)"],
    ["edit <name> [--name|--path|--mode]", "rename, repoint, re-mode or re-exclude a folder"],
    ["rm <path|name>", "stop tracking (keeps its snapshots)"],
    ["list", "show tracked paths + last snapshot"],
    ["dest [<dir>]", "show / set where backups go"],
    ["mode [snapshot|mirror]", "show / set the default backup mode"],
    ["exclude [add|rm <pat…>]", "manage exclude patterns"],
  ]);
  section("back up", [
    ["backup [name|all]", "snapshot now → dest"],
    ["once <path> [--name n]", "one-time snapshot of an unregistered path"],
    ["auto [on [iv] | off | status]", "schedule backups (daily by default)"],
    ["web [--port N]", "local control panel in your browser"],
    ["version", "show the installed version"],
    ["update", "fetch and install the latest version"],
    ["uninstall", "remove backly (keeps your backups)"],
  ]);
  section("restore & maintain", [
    ["snapshots [name|all]", "list a path's snapshots"],
    ["restore <name> [--at s] [--to d]", "copy a snapshot back (newest default)"],
    ["prune [name|all] [--keep N]", "delete old snapshots, keep newest N (5)"],
    ["wipe [name|all]", "permanently purge physical snapshot storage"],
    ["size [name|all]", "tally up exactly how much disk physical backups occupy"],
  ]);
  console.log("\n  " + c.br("▸ ") + c.bold("examples"));

  [
    ["backly add ~/code/my-project", "track a folder"],
    ["backly backup all", "back everything up"],
    ["backly mode mirror", "default to one continuously-updated copy"],
    ["backly auto on daily", "run it on a schedule"],
    ["backly web", "open the control panel"],
  ].forEach(([cmd, desc]) =>
    console.log("    " + c.cyan(cmd) + " ".repeat(Math.max(2, 34 - cmd.length)) + c.dim(desc)));
  console.log();
}

const [cmd, ...args] = process.argv.slice(2);
const table = {
  add: () => cmdAdd(...args),
  rm: () => cmdRemove(args[0]), remove: () => cmdRemove(args[0]),
  list: () => cmdList(), ls: () => cmdList(),
  backup: () => cmdBackup(args[0]), snap: () => cmdBackup(args[0]),
  once: () => cmdOnce(...args),
  snapshots: () => cmdSnapshots(args[0]), snaps: () => cmdSnapshots(args[0]),
  restore: () => cmdRestore(...args),
  prune: () => cmdPrune(...args),
  wipe: () => cmdWipe(args[0]),
  size: () => cmdSize(args[0]),
  dest: () => cmdDest(args[0]),
  exclude: () => cmdExclude(...args),
  auto: () => cmdAuto(...args),
  mode: () => cmdMode(args[0]),
  edit: () => cmdEdit(...args),
  version: () => cmdVersion(), "--version": () => cmdVersion(), "-v": () => cmdVersion(),
  update: () => cmdUpdate(...args), upgrade: () => cmdUpdate(...args),
  uninstall: () => cmdUninstall(...args),
  web: () => cmdWeb(...args), ui: () => cmdWeb(...args),
  help: () => help(), "--help": () => help(), "-h": () => help(),
};
Promise.resolve((table[cmd] || (() => help()))()).catch((e) => die(e.message));
