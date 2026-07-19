# backly

A small, zero-dependency code backup CLI — register folders, snapshot them to a
local drive or NAS, restore them when something goes wrong. Comes with a local
web control panel.

```
backly add ~/code/my-project
backly backup all
backly web
```

## Install

Requires Node 18+. No dependencies, and no git needed — the installer fetches a
tarball with curl or wget.

```bash
git clone https://github.com/zoop-dev/backly.git
cd backly
npm link          # puts `backly` on your PATH
```

## Two backup modes

| Mode | Behaviour |
|---|---|
| `snapshot` | Every change writes a new timestamped copy, so you keep history. |
| `mirror` | One folder kept continuously in sync — changed files replaced, deleted files removed. |

Set the default with `backly mode <snapshot\|mirror>`, or per folder with
`backly add/edit --mode`. A folder with no mode of its own follows the default.

## Commands

```
add <path> [--name n] [--mode m]    track a folder
edit <name> [--name|--path|--mode]  rename, repoint, re-mode or re-exclude
rm <path|name>                      stop tracking (keeps its snapshots)
list                                tracked folders + last snapshot
dest [<dir>]                        show / set where backups go
mode [snapshot|mirror]              show / set the default mode
exclude [add|rm <pat…>]             manage exclude patterns

backup [name|all]                   snapshot now
once <path> [--name n]              one-time snapshot of an untracked path
auto [on [iv] | off | status]       schedule backups (systemd user timer)
web [--port N]                      local control panel

snapshots [name|all]                list a folder's snapshots
restore <name> [--at s] [--to d]    copy a snapshot back
prune [name|all] [--keep N]         delete old snapshots, keep newest N
wipe [name|all]                     purge stored snapshots
size [name|all]                     how much disk the backups occupy
```

Commands that need a target will show a numbered picker when run without one.

## Web control panel

`backly web` prints a URL containing a one-time session token. The panel can
back up, restore, prune, wipe, edit folders, browse the filesystem to add new
ones, and manage the schedule — with live progress and a cancel button.

It binds to `127.0.0.1` only and requires the token on every request. That
matters: any page in your browser can reach `127.0.0.1`, so localhost alone is
not access control. Unexpected `Host` headers are rejected to block DNS
rebinding, and destructive actions require typing the folder's name.

## How it decides something changed

Each snapshot stores a manifest of the source's file sizes and mtimes as they
were at backup time. Comparing against that is exact — and it avoids walking the
destination, which matters when it's a slow USB drive or a network share.

Reading mtimes back off the destination instead would be unreliable: FAT and
exFAT only keep 2-second resolution, so a same-size edit made within that window
could look unchanged indefinitely.

## Notes

- Symlinks are stored dereferenced (as real files), because FAT and SMB targets
  generally cannot recreate them.
- `restore` stages into a sibling folder and swaps at the end, so a cancelled or
  failed restore never leaves you without the original.
- Default excludes: `node_modules`, `dist`, `build`, `.next`, `.cache`,
  `.wrangler`, `.vite`, `.turbo`, `.DS_Store`, `*.log`. `.git` is kept.

## Licence

MIT
