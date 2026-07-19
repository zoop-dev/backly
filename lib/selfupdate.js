
import { readFile, writeFile, mkdir, rm, cp, readdir, stat, realpath, unlink, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HOME } from "./ui.js";
import { exists } from "./engine.js";

export const TARBALL_URL = "https://codeload.github.com/zoop-dev/backly/tar.gz/refs/heads/main";
const PAYLOAD = ["bin", "lib", "package.json"];

function sh(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", () => resolve({ code: 127, out }));
    p.on("close", (code) => resolve({ code, out }));
  });
}

export async function currentVersion() {
  const root = await installRoot();
  const raw = await readFile(path.join(root, "package.json"), "utf8").catch(() => null);
  if (!raw) return "unknown";
  try { return JSON.parse(raw).version || "unknown"; } catch { return "unknown"; }
}

export async function installRoot() {
  const self = fileURLToPath(import.meta.url);
  return path.dirname(path.dirname(await realpath(self).catch(() => self)));
}

export async function isDevCheckout(root) {
  for (const marker of [".git", "scripts", ".gitignore"])
    if (await exists(path.join(root, marker))) return true;
  return false;
}

export async function findLinks(root) {
  const target = path.join(root, "bin", "backly.js");
  const dirs = [
    path.join(HOME, ".local", "bin"), "/usr/local/bin", "/usr/bin",
    ...(process.env.PATH || "").split(":").filter(Boolean),
  ];
  const found = new Set();
  for (const d of new Set(dirs)) {
    const link = path.join(d, "backly");
    const st = await lstat(link).catch(() => null);
    if (!st) continue;
    const resolved = await realpath(link).catch(() => null);
    if (resolved === target) found.add(link);
  }
  return [...found];
}

async function fetchLatest() {
  const dir = path.join(tmpdir(), `backly-update-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const tgz = path.join(dir, "src.tar.gz");

  const res = await fetch(TARBALL_URL).catch((e) => { throw new Error(`download failed: ${e.message}`); });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(tgz, Buffer.from(await res.arrayBuffer()));

  const r = await sh("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
  if (r.code !== 0) throw new Error("could not unpack the download — is `tar` available?");
  await rm(tgz, { force: true });
  if (!(await exists(path.join(dir, "bin", "backly.js"))))
    throw new Error("download looks incomplete — no bin/backly.js");
  return dir;
}

async function fileList(root, rel = "") {
  const out = [];
  const base = path.join(root, rel);
  for (const ent of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) out.push(...await fileList(root, r));
    else out.push(r);
  }
  return out;
}

export async function checkUpdate() {
  const root = await installRoot();
  const staged = await fetchLatest();
  const changed = [];
  for (const top of PAYLOAD) {
    const files = (await stat(path.join(staged, top)).catch(() => null))?.isDirectory()
      ? (await fileList(staged, top))
      : [top];
    for (const rel of files) {
      const a = await readFile(path.join(staged, rel)).catch(() => null);
      const b = await readFile(path.join(root, rel)).catch(() => null);
      if (!a) continue;
      if (!b || !a.equals(b)) changed.push(rel);
    }
  }
  return { root, staged, changed };
}

export async function applyUpdate(staged, root) {
  for (const top of PAYLOAD) {
    const from = path.join(staged, top);
    if (!(await exists(from))) continue;
    await rm(path.join(root, top), { recursive: true, force: true });
    await cp(from, path.join(root, top), { recursive: true });
  }
  await sh("chmod", ["+x", path.join(root, "bin", "backly.js")]);
  await rm(staged, { recursive: true, force: true });
}

export async function removeInstall({ root, links, removeConfig = false, configDir }) {
  for (const l of links) await unlink(l).catch(() => {});
  await rm(root, { recursive: true, force: true });
  if (removeConfig && configDir) await rm(configDir, { recursive: true, force: true });
}
