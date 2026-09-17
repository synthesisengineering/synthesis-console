#!/usr/bin/env bash
# Retire only a verified owned systemd user service; preserve uncertain state.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This script is for Linux." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found." >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="$(command -v bun)"
exec "${BUN_BIN}" "${REPO_ROOT}/scripts/service-ownership.ts" uninstall \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/synthesis-console.service" linux
