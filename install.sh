#!/bin/sh
set -eu

REPO_URL="https://github.com/zoop-dev/backly.git"
TARBALL_URL="https://codeload.github.com/zoop-dev/backly/tar.gz/refs/heads/main"
MIN_NODE=18

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n  \033[31m✗\033[0m %s\n\n' "$*" >&2; exit 1; }

printf '\n  \033[38;2;77;163;255m┌─────┐\033[0m\n'
printf '  \033[38;2;77;163;255m│ ▓▓▓ │\033[0m  backly installer\n'
printf '  \033[38;2;77;163;255m└─────┘\033[0m\n\n'

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--help) say "usage: install.sh [--force]"; say "  --force  reinstall over an existing install"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

node_install_cmd() {
  if   command -v apt-get >/dev/null 2>&1; then echo "$SUDO apt-get install -y nodejs npm"
  elif command -v dnf     >/dev/null 2>&1; then echo "$SUDO dnf install -y nodejs"
  elif command -v pacman  >/dev/null 2>&1; then echo "$SUDO pacman -S --noconfirm nodejs npm"
  elif command -v zypper  >/dev/null 2>&1; then echo "$SUDO zypper install -y nodejs"
  elif command -v apk     >/dev/null 2>&1; then echo "$SUDO apk add nodejs npm"
  elif command -v brew    >/dev/null 2>&1; then echo "brew install node"
  else echo ""
  fi
}

# Prompt via /dev/tty: under `curl | sh` stdin is the script itself, so reading
# from it would swallow the rest of the installer. No tty means no prompting.
ask_yn() {
  # -r alone isn't enough: /dev/tty can exist yet fail to open when there's no
  # controlling terminal, so actually try it (quietly) before prompting.
  # The probe runs in a subshell because a redirection failure on a special
  # builtin like ":" makes a non-interactive POSIX shell exit outright.
  ( true > /dev/tty ) 2>/dev/null || return 1
  printf '  \033[38;2;77;163;255m?\033[0m %s [y/N]: ' "$1" > /dev/tty 2>/dev/null
  read -r reply < /dev/tty 2>/dev/null || return 1
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$MIN_NODE" ]; then
  ok "node v$(node_major)"
else
  if command -v node >/dev/null 2>&1; then
    warn "node v$(node_major) found, but backly needs v$MIN_NODE+"
  else
    warn "node is not installed (backly needs v$MIN_NODE+)"
  fi

  INSTALL_CMD=$(node_install_cmd)
  if [ -z "$INSTALL_CMD" ]; then
    say "no supported package manager found — install node yourself:"
    printf '\n      https://nodejs.org/en/download\n\n'
    exit 1
  fi

  if ask_yn "install node now with: $INSTALL_CMD ?"; then
    say "installing node…"
    if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq || true; fi
    # shellcheck disable=SC2086
    $INSTALL_CMD || die "node install failed — run it yourself and re-run this installer"
    command -v node >/dev/null 2>&1 || die "node still not on PATH after install"
    if [ "$(node_major)" -lt "$MIN_NODE" ]; then
      warn "your package manager installed node v$(node_major), older than v$MIN_NODE"
      say "get a current version from https://nodejs.org or use nvm, then re-run this installer"
      exit 1
    fi
    ok "node v$(node_major)"
  else
    say "no problem — install node with:"
    printf '\n      %s\n\n' "$INSTALL_CMD"
    say "then re-run this installer."
    exit 1
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  LIBDIR="/usr/local/lib/backly"
  BINDIR="/usr/local/bin"
else
  LIBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/backly"
  BINDIR="$HOME/.local/bin"
fi

# Fail before downloading anything, and point at the supported upgrade path.
if [ "$FORCE" -eq 0 ] && { [ -d "$LIBDIR" ] || command -v backly >/dev/null 2>&1; }; then
  INSTALLED_AT="$LIBDIR"
  [ -d "$LIBDIR" ] || INSTALLED_AT=$(command -v backly)
  CUR=""
  [ -f "$LIBDIR/package.json" ] && CUR=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LIBDIR/package.json" 2>/dev/null | head -1)
  warn "backly is already installed${CUR:+ (v$CUR)}"
  say  "at $INSTALLED_AT"
  printf '\n  to upgrade:    \033[36mbackly update\033[0m\n'
  printf '  to remove:     \033[36mbackly uninstall\033[0m\n'
  printf '  to reinstall:  \033[36mre-run this installer with --force\033[0m\n\n'
  exit 1
fi

SRC=""
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SCRIPT_DIR=""

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else return 1
  fi
}

if [ -f "$0" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/backly.js" ]; then
  SRC="$SCRIPT_DIR"
  ok "installing from $SRC"
else
  TMP=$(mktemp -d)
  SRC="$TMP"
  say "fetching backly…"
  if command -v tar >/dev/null 2>&1 && download "$TARBALL_URL" "$TMP/src.tar.gz" 2>/dev/null; then
    tar -xzf "$TMP/src.tar.gz" -C "$TMP" --strip-components=1 || die "could not unpack the download"
    rm -f "$TMP/src.tar.gz"
    ok "fetched"
  elif command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL" "$SRC" >/dev/null 2>&1 || die "clone failed: $REPO_URL"
    ok "fetched (git)"
  else
    die "need curl or wget (plus tar), or git, to fetch backly"
  fi
fi

[ -f "$SRC/bin/backly.js" ] || die "download looks incomplete — no bin/backly.js"

# Parsed with sed rather than node so the version is reported even if the
# package.json is odd in some way that would make a require() blow up.
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/package.json" 2>/dev/null | head -1)
[ -n "$VERSION" ] && ok "backly v$VERSION"

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
