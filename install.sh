#!/bin/sh
set -eu

REPO_URL="https://github.com/zoop-dev/backly.git"
MIN_NODE=18

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n  \033[31m✗\033[0m %s\n\n' "$*" >&2; exit 1; }

printf '\n  \033[38;2;77;163;255m┌─────┐\033[0m\n'
printf '  \033[38;2;77;163;255m│ ▓▓▓ │\033[0m  backly installer\n'
printf '  \033[38;2;77;163;255m└─────┘\033[0m\n\n'

command -v node >/dev/null 2>&1 || die "node is required (v$MIN_NODE+). See https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge "$MIN_NODE" ] || die "node v$MIN_NODE+ required, found v$NODE_MAJOR"
ok "node v$NODE_MAJOR"

SRC=""
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SCRIPT_DIR=""

if [ -f "$0" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/backly.js" ]; then
  SRC="$SCRIPT_DIR"
  ok "installing from $SRC"
else
  command -v git >/dev/null 2>&1 || die "git is required to fetch backly"
  TMP=$(mktemp -d)
  SRC="$TMP"
  say "fetching backly…"
  git clone --depth 1 "$REPO_URL" "$SRC" >/dev/null 2>&1 || die "clone failed: $REPO_URL"
  ok "fetched"
fi

if [ "$(id -u)" -eq 0 ]; then
  LIBDIR="/usr/local/lib/backly"
  BINDIR="/usr/local/bin"
else
  LIBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/backly"
  BINDIR="$HOME/.local/bin"
fi

mkdir -p "$LIBDIR" "$BINDIR"
rm -rf "$LIBDIR/bin" "$LIBDIR/lib"
cp -R "$SRC/bin" "$SRC/lib" "$LIBDIR/"
[ -f "$SRC/package.json" ] && cp "$SRC/package.json" "$LIBDIR/"
chmod +x "$LIBDIR/bin/backly.js"

ln -sf "$LIBDIR/bin/backly.js" "$BINDIR/backly"
ok "installed to $LIBDIR"
ok "linked $BINDIR/backly"

if ! "$BINDIR/backly" help >/dev/null 2>&1; then
  die "installed, but 'backly help' failed to run"
fi
ok "verified"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *)
    warn "$BINDIR is not on your PATH"
    say "add this to your shell profile:"
    printf '\n      export PATH="%s:$PATH"\n' "$BINDIR"
    ;;
esac

printf '\n  run \033[36mbackly help\033[0m to get started\n\n'
