
import { writeFile, mkdir, rm, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HOME } from "./ui.js";

export const SYSTEMD_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "systemd", "user");
const SVC = path.join(SYSTEMD_DIR, "backly.service");
const TMR = path.join(SYSTEMD_DIR, "backly.timer");

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backly.js");

const exists = (p) => access(p).then(() => true).catch(() => false);

export function sh(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", () => resolve({ code: 127, out }));
    p.on("close", (code) => resolve({ code, out }));
  });
}

export function parseInterval(s) {
  s = (s || "daily").toLowerCase();
  if (["hourly", "daily", "weekly"].includes(s)) return { calendar: s, label: s };
  const m = s.match(/^(\d+)\s*(m|min|h|hr|hour|d|day)s?$/);
  if (!m) return null;
  const n = +m[1], u = m[2][0];
  const sec = u === "m" ? n * 60 : u === "h" ? n * 3600 : n * 86400;
  return { sec, label: n + u };
}

export async function scheduleStatus() {
  if (!(await exists(TMR))) return { installed: false, active: false, next: null, interval: null };
  const { out } = await sh("systemctl", ["--user", "is-active", "backly.timer"]);
  const t = await sh("systemctl", ["--user", "list-timers", "backly.timer", "--no-pager", "--no-legend"]);
  const line = t.out.trim().split("\n")[0] || "";

  const next = line ? line.replace(/\s+/g, " ").split(" backly")[0].trim() : null;
  const unit = await import("node:fs/promises").then((fs) => fs.readFile(TMR, "utf8")).catch(() => "");
  const cal = unit.match(/OnCalendar=(.+)/);
  const sec = unit.match(/OnUnitActiveSec=(\d+)/);
  return {
    installed: true,
    active: out.trim() === "active",
    next,
    interval: cal ? cal[1].trim() : sec ? `${sec[1]}s` : null,
  };
}

export async function scheduleOn(rawInterval) {
  const iv = parseInterval(rawInterval);
  if (!iv) throw new Error("bad interval — try hourly · daily · weekly · 6h · 30m · 2d");
  await mkdir(SYSTEMD_DIR, { recursive: true });
  await writeFile(SVC,
`[Unit]
Description=backly — snapshot registered code paths

[Service]
Type=oneshot
ExecStart=${process.execPath} ${path.resolve(CLI)} backup all
`);
  const when = iv.calendar ? `OnCalendar=${iv.calendar}` : `OnBootSec=2min\nOnUnitActiveSec=${iv.sec}`;
  await writeFile(TMR,
`[Unit]
Description=backly auto-backup schedule

[Timer]
${when}
Persistent=true

[Install]
WantedBy=timers.target
`);
  await sh("systemctl", ["--user", "daemon-reload"]);
  const r = await sh("systemctl", ["--user", "enable", "--now", "backly.timer"]);
  if (r.code !== 0) throw new Error("couldn't enable the timer: " + r.out.trim());
  return { ...iv, label: iv.calendar || `every ${iv.label}` };
}

export async function scheduleOff() {
  await sh("systemctl", ["--user", "disable", "--now", "backly.timer"]);
  await rm(SVC, { force: true });
  await rm(TMR, { force: true });
  await sh("systemctl", ["--user", "daemon-reload"]);
  return { off: true };
}
