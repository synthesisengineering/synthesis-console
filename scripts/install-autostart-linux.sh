#!/usr/bin/env bash
#
# Install Synthesis Console as a systemd user unit so it starts on login.
#
# Creates ~/.config/systemd/user/synthesis-console.service, enables it,
# and starts it. Logs go through journald; view with:
#   journalctl --user -u synthesis-console -f
#
# Idempotent: re-running regenerates the unit file and restarts.
# Uninstall with: scripts/uninstall-autostart-linux.sh
#
# If you want the service to run even when you're not logged in:
#   loginctl enable-linger "$USER"

set -euo pipefail

UNIT_NAME="synthesis-console.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/scripts/python-runtime.sh"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This script is for Linux. For macOS, use install-autostart-macos.sh." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found. This script requires systemd." >&2
  exit 1
fi

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "${HOME}/.bun/bin/bun" "/usr/local/bin/bun" "/usr/bin/bun"; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

BUN_BIN="$(find_bun || true)"
if [[ -z "${BUN_BIN}" ]]; then
  echo "Error: Could not find 'bun' executable." >&2
  echo "Install Bun first: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

PYTHON_BIN="$(find_synthesis_python || true)"
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "Error: Could not find a Python 3 interpreter with PyYAML." >&2
  echo "Install PyYAML or set SYNTHESIS_PYTHON_BIN to a compatible interpreter." >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "Error: Dependencies not installed. Run 'bun install' in ${REPO_ROOT} first." >&2
  exit 1
fi

systemd_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s\n' "${value}"
}

systemd_escape_exec() {
  local value
  value="$(systemd_escape "$1")"
  value="${value//\$/\$\$}"
  printf '%s\n' "${value}"
}

mkdir -p "${UNIT_DIR}"

PRIVATE_CONTROL_PLANE_ENV=""
if [[ "${SYNTHESIS_PRIVATE_CONTROL_PLANE:-0}" == "1" ]]; then
  PRIVATE_CONTROL_PLANE_ENV="Environment=SYNTHESIS_PRIVATE_CONTROL_PLANE=1"
fi

REPO_ROOT_SYSTEMD="$(systemd_escape "${REPO_ROOT}")"
BUN_BIN_SYSTEMD="$(systemd_escape_exec "${BUN_BIN}")"
SERVICE_PATH_SYSTEMD="$(systemd_escape "$(dirname "${BUN_BIN}"):/usr/local/bin:/usr/bin:/bin")"
PYTHON_BIN_SYSTEMD="$(systemd_escape "${PYTHON_BIN}")"

cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=Synthesis Console — local dashboard for synthesis engineering
Documentation=https://github.com/synthesisengineering/synthesis-console
After=network.target

[Service]
Type=simple
WorkingDirectory="${REPO_ROOT_SYSTEMD}"
ExecStart="${BUN_BIN_SYSTEMD}" run src/index.ts
Restart=on-failure
RestartSec=10
Environment="PATH=${SERVICE_PATH_SYSTEMD}"
Environment="SYNTHESIS_PYTHON_BIN=${PYTHON_BIN_SYSTEMD}"
${PRIVATE_CONTROL_PLANE_ENV}

[Install]
WantedBy=default.target
UNIT

echo "Wrote unit: ${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}"
systemctl --user restart "${UNIT_NAME}"

echo ""
echo "Synthesis Console is installed to start on login."
echo "  Unit:  ${UNIT_NAME}"
echo "  Repo:  ${REPO_ROOT}"
echo "  Bun:   ${BUN_BIN}"
echo "  Python: ${PYTHON_BIN}"
echo "  Logs:  journalctl --user -u synthesis-console -f"
echo ""
echo "It should already be running. Try: xdg-open http://localhost:5555"
echo ""
echo "To run even when not logged in: loginctl enable-linger \"\$USER\""
echo "Uninstall with: ${REPO_ROOT}/scripts/uninstall-autostart-linux.sh"
