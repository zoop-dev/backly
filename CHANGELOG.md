# Changelog

## v1.1.1 — 2026-07-19

- `backly auto` now rejects intervals under a minute; `0m` previously produced a timer that re-fired immediately, looping backups against the drive
- Interval names tolerate surrounding whitespace, so `"weekly "` is accepted like `"45 m"` already was
- Rejected intervals say whether the value was unparseable or simply too short

## v1.1.0 — 2026-07-19

- Consolidated snapshot metadata into a single `stats.json` per project, instead of two JSON files per snapshot cluttering the vault
- Existing vaults migrate automatically on first read; `stats.json` is written atomically so an interrupted backup can't corrupt it
- Added `backly changelog` to read release notes, and `backly update` now shows the incoming version's notes before you install
- `backly update` and the installer report the version they're installing
- The installer refuses to run over an existing install, pointing at `backly update` (use `--force` to override)

## v1.0.0 — 2026-07-19

- Snapshot and mirror backup modes, per folder or vault-wide (`backly mode`)
- Change detection via a per-snapshot manifest of source sizes and mtimes — exact, and it never walks the destination
- Local web control panel (`backly web`): backup, restore, prune, wipe, edit, schedule, folder picker, live progress and cancel
- Scheduled backups through a systemd user timer (`backly auto`)
- `backly update`, `backly uninstall` and `backly version`
- `install.sh` with no git requirement, and an offer to install Node if it's missing
- Symlinks are stored dereferenced, so FAT and SMB destinations work
- `restore` stages into a sibling and swaps, so a cancelled restore never leaves you without the original
