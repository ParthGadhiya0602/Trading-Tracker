#!/usr/bin/env bash
# Trading Tracker launcher - starts the NIFTY 50 dashboard server.
# Usage:  ./run.sh        (or double-click on macOS if renamed run.command)
set -e

# Always run from the folder this script lives in, so it works from anywhere.
cd "$(dirname "$0")"

# Load nvm if present (Chromebook/Mac installs often put node there, not on PATH).
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

NODE_REQUIREMENT="Node.js 24 LTS (>=24.11.0 <25)"

node_supported() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 11 ? 0 : 1)' \
      >/dev/null 2>&1
}

# Node missing or outside the supported LTS line: install Node 24 via the OS package manager.
if ! node_supported; then
  if [ "$(command -v node >/dev/null 2>&1 && echo yes || echo no)" = "yes" ]; then
    echo "Node $(node -v) found, but ${NODE_REQUIREMENT} is required. Installing Node 24..."
  else
    echo "Node.js is not installed. Installing Node 24 LTS..."
  fi

  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install node@24
      else
        echo "Homebrew not found. Install it from https://brew.sh, then run: brew install node@24"
        exit 1
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        echo "Installing via NodeSource (needs sudo)..."
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
        sudo apt-get install -y nodejs
      else
        echo "No supported package manager found. Install ${NODE_REQUIREMENT} manually."
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS. Install ${NODE_REQUIREMENT} manually."
      exit 1
      ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node install failed - node still not found on PATH."
  exit 1
fi
if ! node_supported; then
  echo "Node $(node -v) found, but ${NODE_REQUIREMENT} is required. Installation did not provide a supported runtime."
  exit 1
fi

PORT=8787

# Free the port if a previous run is still listening on it.
# lsof ships by default on macOS but often isn't installed on a fresh
# Crostini/Debian container, so fall back to fuser, then give up with
# a clear message rather than failing silently.
if command -v lsof >/dev/null 2>&1; then
  EXISTING_PID="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ]; then
    echo "Port $PORT is in use (pid $EXISTING_PID) - stopping it..."
    kill "$EXISTING_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
  fi
elif command -v fuser >/dev/null 2>&1; then
  if fuser "$PORT/tcp" >/dev/null 2>&1; then
    echo "Port $PORT is in use - stopping it..."
    fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    sleep 1
  fi
else
  echo "Note: neither lsof nor fuser is installed, so a stale server on port $PORT can't be auto-stopped."
  echo "  Chromebook/Linux: sudo apt install -y lsof"
  echo "If startup fails with 'address already in use', stop the old process manually and re-run."
fi

echo "Starting Trading Tracker with $(node -v) ..."
exec node backend/server.js
