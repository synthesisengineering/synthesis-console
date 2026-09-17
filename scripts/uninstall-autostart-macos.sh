#!/usr/bin/env bash
# Retire only a verified owned macOS login service; preserve uncertain state.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: This script is for macOS." >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="$(command -v bun)"
exec "${BUN_BIN}" "${REPO_ROOT}/scripts/service-ownership.ts" uninstall \
  "${HOME}/Library/LaunchAgents/org.synthesisengineering.console.plist" macos
