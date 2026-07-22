#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_DIR="$SCRIPT_DIR"
readonly REQUIRED_NODE_VERSION="${VHEAP_NODE_VERSION:-22.14.0}"
readonly REQUIRED_PNPM_VERSION="${VHEAP_PNPM_VERSION:-10.33.0}"
readonly TOOLS_DIR="${VHEAP_TOOLS_DIR:-$PROJECT_DIR/.tools}"

PWNDBG_ROOT="${PWNDBG_PATH:-}"
PWNDBG_PYTHON=""
SKIP_FRONTEND=0
WRITE_GDBINIT=1
NODE_TMP_DIR=""

log() {
  printf '[vHeap] %s\n' "$*"
}

die() {
  printf '[vHeap] error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$NODE_TMP_DIR" && -d "$NODE_TMP_DIR" ]]; then
    rm -rf -- "$NODE_TMP_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  ./setup.sh [PWNDBG_PATH] [options]

Options:
  --pwndbg PATH       Explicit pwndbg root directory.
  --skip-frontend     Skip Node/pnpm setup and the production frontend build.
  --no-gdbinit        Do not add vheap.py to ~/.gdbinit.
  -h, --help          Show this help text.

The script auto-detects pwndbg under common locations such as ~/pwndbg.
PWNDBG_PATH can also be supplied through the environment.
EOF
}

while (($# > 0)); do
  case "$1" in
    --pwndbg)
      (($# >= 2)) || die "--pwndbg requires a directory"
      PWNDBG_ROOT="$2"
      shift 2
      ;;
    --skip-frontend)
      SKIP_FRONTEND=1
      shift
      ;;
    --no-gdbinit)
      WRITE_GDBINIT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      (($# == 0)) || die "unexpected argument: $1"
      ;;
    -*)
      die "unknown option: $1 (run ./setup.sh --help)"
      ;;
    *)
      [[ -z "$PWNDBG_ROOT" ]] || die "pwndbg path was supplied more than once"
      PWNDBG_ROOT="$1"
      shift
      ;;
  esac
done

command -v gdb >/dev/null 2>&1 || die "GDB 11 or newer is required"
GDB_VERSION_LINE="$(gdb --version 2>/dev/null | head -n 1 || true)"
[[ "$GDB_VERSION_LINE" =~ ([0-9]+)\. ]] || die "could not determine the installed GDB version"
GDB_MAJOR="${BASH_REMATCH[1]}"
((GDB_MAJOR >= 11)) || die "GDB 11 or newer is required (found: $GDB_VERSION_LINE)"
log "using ${GDB_VERSION_LINE:-GDB}"

pwndbg_python_for_root() {
  local root="$1"
  local candidate
  for candidate in \
    "$root/.venv/bin/python3" \
    "$root/.venv/bin/python" \
    "$root/bin/python3" \
    "$root/bin/python"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_pwndbg() {
  local candidate resolved python launcher
  local -a candidates=()

  if [[ -n "$PWNDBG_ROOT" ]]; then
    candidates+=("$PWNDBG_ROOT")
  else
    if [[ -n "${HOME:-}" ]]; then
      candidates+=(
        "$HOME/pwndbg"
        "$HOME/pwndbg-dev"
        "$HOME/.pwndbg"
        "$HOME/.local/share/pwndbg"
      )
      shopt -s nullglob
      for candidate in "$HOME"/pwndbg-*; do candidates+=("$candidate"); done
      shopt -u nullglob
    fi
    candidates+=(
      "$PROJECT_DIR/../pwndbg"
      "$PROJECT_DIR/../pwndbg-dev"
      "/opt/pwndbg"
      "/usr/local/pwndbg"
      "/usr/local/share/pwndbg"
    )
    if launcher="$(command -v pwndbg 2>/dev/null)"; then
      candidates+=(
        "$(dirname -- "$launcher")"
        "$(dirname -- "$(dirname -- "$launcher")")"
        "$(dirname -- "$(dirname -- "$(dirname -- "$launcher")")")"
      )
    fi
  fi

  for candidate in "${candidates[@]}"; do
    [[ -d "$candidate" ]] || continue
    resolved="$(cd -- "$candidate" && pwd -P)"
    if python="$(pwndbg_python_for_root "$resolved")"; then
      PWNDBG_ROOT="$resolved"
      PWNDBG_PYTHON="$python"
      return 0
    fi
  done
  return 1
}

resolve_pwndbg || die "could not find pwndbg's .venv; run ./setup.sh /absolute/path/to/pwndbg"
log "using pwndbg at $PWNDBG_ROOT"
log "installing Python dependencies into $PWNDBG_PYTHON"

PYTHON_VERSION="$("$PWNDBG_PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [[ "$PYTHON_VERSION" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
  ((BASH_REMATCH[1] > 3 || (BASH_REMATCH[1] == 3 && BASH_REMATCH[2] >= 9))) \
    || die "Python 3.9 or newer is required in the pwndbg virtual environment (found: $PYTHON_VERSION)"
else
  die "could not determine the pwndbg Python version"
fi
log "using Python $PYTHON_VERSION"

if ! "$PWNDBG_PYTHON" -m pip --version >/dev/null 2>&1; then
  log "pip is missing; bootstrapping it in the pwndbg virtual environment"
  "$PWNDBG_PYTHON" -m ensurepip --upgrade
fi
"$PWNDBG_PYTHON" -m pip install --disable-pip-version-check -r "$PROJECT_DIR/requirements.txt"
"$PWNDBG_PYTHON" -c 'import aiohttp, requests, socketio' \
  || die "Python dependencies were installed but could not be imported"

node_is_supported() {
  local node_bin="$1"
  "$node_bin" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
    process.exit(supported ? 0 : 1);
  ' >/dev/null 2>&1
}

download_file() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --show-error --silent "$url" --output "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --tries=3 --output-document="$output" "$url"
  else
    die "curl or wget is required to download the local Node.js toolchain"
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify the Node.js download"
  fi
}

install_local_node() {
  local machine node_arch archive release_dir base_url expected actual
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "unsupported architecture for automatic Node.js setup: $machine" ;;
  esac

  release_dir="node-v${REQUIRED_NODE_VERSION}-linux-${node_arch}"
  archive="${release_dir}.tar.xz"
  if node_is_supported "$TOOLS_DIR/$release_dir/bin/node"; then
    printf '%s\n' "$TOOLS_DIR/$release_dir/bin/node"
    return 0
  fi

  command -v tar >/dev/null 2>&1 || die "tar is required to install the local Node.js toolchain"
  mkdir -p "$TOOLS_DIR"
  NODE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vheap-node.XXXXXX")"
  base_url="https://nodejs.org/dist/v${REQUIRED_NODE_VERSION}"
  log "downloading Node.js v${REQUIRED_NODE_VERSION} for linux-${node_arch}" >&2
  download_file "$base_url/$archive" "$NODE_TMP_DIR/$archive"
  download_file "$base_url/SHASUMS256.txt" "$NODE_TMP_DIR/SHASUMS256.txt"
  expected="$(awk -v archive="$archive" '$2 == archive || $2 == "*" archive { print $1 }' "$NODE_TMP_DIR/SHASUMS256.txt")"
  [[ -n "$expected" ]] || die "Node.js checksum is missing for $archive"
  actual="$(sha256_file "$NODE_TMP_DIR/$archive")"
  [[ "$actual" == "$expected" ]] || die "Node.js checksum verification failed"
  tar -xJf "$NODE_TMP_DIR/$archive" -C "$TOOLS_DIR"
  node_is_supported "$TOOLS_DIR/$release_dir/bin/node" \
    || die "the downloaded Node.js executable cannot run on this system"
  printf '%s\n' "$TOOLS_DIR/$release_dir/bin/node"
}

prepare_frontend() {
  local node_bin pnpm_bin pnpm_version npm_bin local_pnpm_home
  local -a pnpm_cmd

  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_bin" ]] || ! node_is_supported "$node_bin"; then
    [[ -z "$node_bin" ]] || log "system Node.js $("$node_bin" --version) is too old for Vite"
    node_bin="$(install_local_node)"
  fi
  export PATH="$(dirname -- "$node_bin"):$PATH"
  log "using Node.js $("$node_bin" --version)"

  pnpm_bin="$(command -v pnpm 2>/dev/null || true)"
  pnpm_version=""
  if [[ -n "$pnpm_bin" ]]; then
    pnpm_version="$("$pnpm_bin" --version 2>/dev/null || true)"
  fi
  if [[ "$pnpm_version" =~ ^10\. ]]; then
    pnpm_cmd=("$pnpm_bin")
  else
    local_pnpm_home="$TOOLS_DIR/pnpm"
    pnpm_bin="$local_pnpm_home/bin/pnpm"
    pnpm_version="$("$pnpm_bin" --version 2>/dev/null || true)"
    if [[ ! "$pnpm_version" =~ ^10\. ]]; then
      npm_bin="$(command -v npm 2>/dev/null || true)"
      [[ -n "$npm_bin" ]] || die "npm is required to prepare pnpm $REQUIRED_PNPM_VERSION"
      log "installing pnpm $REQUIRED_PNPM_VERSION under $local_pnpm_home"
      "$npm_bin" install --global --prefix "$local_pnpm_home" "pnpm@$REQUIRED_PNPM_VERSION"
    fi
    pnpm_cmd=("$pnpm_bin")
  fi

  log "using pnpm $("${pnpm_cmd[@]}" --version)"
  cd -- "$PROJECT_DIR"
  log "installing locked frontend dependencies"
  CI=1 "${pnpm_cmd[@]}" install --frozen-lockfile
  log "building the TypeScript frontend"
  "${pnpm_cmd[@]}" build
  [[ -f "$PROJECT_DIR/vheapViews/dist/index.html" ]] \
    || die "frontend build completed without vheapViews/dist/index.html"
}

if ((SKIP_FRONTEND == 0)); then
  prepare_frontend
else
  log "skipping frontend dependency setup and build"
fi

install_gdbinit_entry() {
  local gdbinit_path begin_marker end_marker source_line temp_file
  [[ -n "${HOME:-}" ]] || die "HOME is not set; use --no-gdbinit or set HOME"
  if [[ -n "${GDBINIT:-}" ]]; then
    gdbinit_path="$GDBINIT"
  elif [[ -f "$HOME/.gdbinit" || ! -f "$HOME/.config/gdb/gdbinit" ]]; then
    gdbinit_path="$HOME/.gdbinit"
  else
    gdbinit_path="$HOME/.config/gdb/gdbinit"
  fi
  begin_marker="# >>> vHeap >>>"
  end_marker="# <<< vHeap <<<"
  source_line="source $PROJECT_DIR/vheap.py"
  mkdir -p -- "$(dirname -- "$gdbinit_path")"
  touch "$gdbinit_path"
  temp_file="$(mktemp "${TMPDIR:-/tmp}/vheap-gdbinit.XXXXXX")"

  awk -v begin="$begin_marker" -v end="$end_marker" -v source="$source_line" '
    $0 == begin { managed = 1; next }
    $0 == end { managed = 0; next }
    !managed && $0 != source { print }
  ' "$gdbinit_path" > "$temp_file"
  if [[ -s "$temp_file" ]] && [[ -n "$(tail -c 1 "$temp_file")" ]]; then
    printf '\n' >> "$temp_file"
  fi
  printf '%s\n%s\n%s\n' "$begin_marker" "$source_line" "$end_marker" >> "$temp_file"
  cat "$temp_file" > "$gdbinit_path"
  rm -f -- "$temp_file"
  log "registered vheap.py in $gdbinit_path"
}

if ((WRITE_GDBINIT == 1)); then
  install_gdbinit_entry
else
  log "skipping .gdbinit update"
fi

log "installation complete"
log "restart GDB, run a target, then execute: vhserv localhost 8080"
