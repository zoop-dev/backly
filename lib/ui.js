
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import process from "node:process";

export const tty = process.stdout.isTTY;
export const HOME = os.homedir();

const E = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : `${s}`);
export const c = {
  dim: E(2), bold: E(1), red: E(31), green: E(32), yellow: E(33),
  blue: E(34), cyan: E(36), mag: E(35), grey: E(90),
  br: E("38;2;77;163;255"),
};
export const ok = c.green("✓"), bad = c.red("✗"), dot = c.br("•");

export function banner() {
  const b = c.br, d = c.dim;
  console.log();
  console.log("   " + b("   ┌─────┐"));
  console.log("   " + b("   │ ▓▓▓ │") + "   " + c.bold("backly"));
  console.log("   " + b("   │ ▓▓▓ │") + "   " + d("snapshot your code, locally"));
  console.log("   " + b("   └─────┘"));
  console.log();
}

export function die(msg) { console.log("\n  " + bad + " " + msg + "\n"); process.exit(1); }
export function header(t) { console.log("\n  " + c.bold(c.br("▸ ")) + c.bold(t)); }

export const expand = (p) => (p.startsWith("~") ? path.join(HOME, p.slice(1)) : p);
export const shortHome = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

export function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
export function humanSize(bytes) {
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

export function terminalProgress() {
  if (!tty) return { onProgress: null, finish: () => {} };
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  return {
    onProgress(p) {
      const etaStr = p.etaSec > 60 ? `${Math.floor(p.etaSec / 60)}m ${p.etaSec % 60}s` : `${p.etaSec}s`;
      const detail = `${p.percent}% | ${humanSize(p.copiedBytes)} / ${humanSize(p.totalBytes)}` +
        ` | ${p.copiedFiles}/${p.totalFiles} files | ETA: ${etaStr}`;
      process.stdout.write(
        `\r    ${c.cyan(frames[i++ % frames.length])} Copying ${c.br(p.name)} - ` +
        c.grey(`[ ${detail} ]`) + "\x1b[K"
      );
    },
    finish() { process.stdout.write("\r\x1b[K"); },
  };
}

export function promptVisible(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    rl.on("SIGINT", () => { rl.close(); process.stdout.write("\n"); process.exit(130); });

    rl.on("close", () => { if (!answered) resolve(""); });
    rl.question(query, (ans) => { answered = true; rl.close(); resolve(ans); });
  });
}
export async function ask(label, { def = "", required = false } = {}) {
  for (;;) {
    const hint = def ? c.dim(` [${def}]`) : (required ? c.dim(" (required)") : c.dim(" (optional)"));
    const a = (await promptVisible("    " + c.br("?") + " " + c.bold(label) + hint + c.dim(": "))).trim();
    if (a) return a;
    if (def) return def;
    if (!required) return "";
    console.log("      " + c.yellow("• required"));
  }
}

export async function pick(label, items, {
  render = String, name = (x) => String(x), extra = {}, prompt = "Pick one (number)",
} = {}) {
  if (!tty || !items.length) return {};
  console.log("    " + dot + c.dim(" " + label + ":"));
  items.forEach((it, i) =>
    console.log("      " + c.cyan(String(i + 1).padStart(2)) + ". " + render(it)));
  for (const [k, text] of Object.entries(extra))
    console.log("       " + c.cyan(k.toUpperCase()) + ". " + c.dim(text));

  for (;;) {
    const raw = await ask(prompt, { required: true });
    const key = Object.keys(extra).find((k) => k.toLowerCase() === raw.toLowerCase());
    if (key) return { key };
    const n = parseInt(raw);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return { item: items[n - 1] };
    const byName = items.find((it) => name(it).toLowerCase() === raw.toLowerCase());
    if (byName) return { item: byName };
    console.log("      " + c.yellow(`• pick 1–${items.length}` +
      (Object.keys(extra).length ? ", or " + Object.keys(extra).join("/").toUpperCase() : "")));
  }
}

export async function confirm(label, def = true) {
  const q = "    " + c.br("?") + " " + c.bold(label) + c.dim(def ? " [Y/n]: " : " [y/N]: ");
  const a = (await promptVisible(q)).trim().toLowerCase();
  return a ? a[0] === "y" : def;
}
