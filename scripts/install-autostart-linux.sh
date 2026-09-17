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
# Preserve terminal newlines long enough to reject them, rather than letting
# command substitution silently select a different directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && printf '%s.' "$PWD")"
REPO_ROOT="${REPO_ROOT%.}"

systemd_working_directory() {
  local value="$1" tail="$1" backslashes=0
  while [[ "${tail}" == *\\ ]]; do
    tail="${tail%\\}"
    backslashes=$((backslashes + 1))
  done
  # This directive has neither unquoting nor C-unescaping. The unit parser
  # trims trailing whitespace and joins lines ending in an odd backslash.
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* || "${value}" == *[[:space:]] ]] || \
      (( backslashes % 2 )); then
    echo "Error: Repository path cannot be represented exactly in systemd WorkingDirectory." >&2
    return 1
  fi
  value="${value//%/%%}"
  printf '%s\n' "${value}"
}

REPO_ROOT_SYSTEMD="$(systemd_working_directory "${REPO_ROOT}")"
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


if [[ ! -d "${REPO_ROOT}/node_modules" && ! -f "${REPO_ROOT}/app/index.js" ]]; then
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

"${BUN_BIN}" "${REPO_ROOT}/scripts/service-ownership.ts" check "${UNIT_PATH}"

# Foreign service state is refused before provisioning any runtime files.
BOOTSTRAP_PYTHON="$(console_bootstrap_python)"
PYTHON_BIN="$(provision_synthesis_python)"


mkdir -p "${UNIT_DIR}"

PRIVATE_CONTROL_PLANE_ENV=""
if [[ "${SYNTHESIS_PRIVATE_CONTROL_PLANE:-0}" == "1" ]]; then
  PRIVATE_CONTROL_PLANE_ENV="Environment=SYNTHESIS_PRIVATE_CONTROL_PLANE=1"
fi

BUN_BIN_SYSTEMD="$(systemd_escape_exec "${BUN_BIN}")"
SERVICE_PATH_SYSTEMD="$(systemd_escape "$(dirname "${BUN_BIN}"):/usr/local/bin:/usr/bin:/bin")"
PYTHON_BIN_SYSTEMD="$(systemd_escape "${PYTHON_BIN}")"
BOOTSTRAP_PYTHON_SYSTEMD="$(systemd_escape "${BOOTSTRAP_PYTHON}")"
DATA_HOME_SYSTEMD="$(systemd_escape "${XDG_DATA_HOME:-$HOME/.local/share}")"

cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=Synthesis Console — local dashboard for synthesis engineering
Documentation=https://github.com/synthesisengineering/synthesis-console
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT_SYSTEMD}
ExecStart=/usr/bin/env "${BUN_BIN_SYSTEMD}" run scripts/console-cli.ts start
Restart=on-failure
RestartSec=10
Environment="PATH=${SERVICE_PATH_SYSTEMD}"
Environment="SYNTHESIS_PYTHON_BIN=${PYTHON_BIN_SYSTEMD}"
Environment="SYNTHESIS_BOOTSTRAP_PYTHON=${BOOTSTRAP_PYTHON_SYSTEMD}"
Environment=PYTHONDONTWRITEBYTECODE=1
Environment="XDG_DATA_HOME=${DATA_HOME_SYSTEMD}"
${PRIVATE_CONTROL_PLANE_ENV}

[Install]
WantedBy=default.target
UNIT

"${BUN_BIN}" "${REPO_ROOT}/scripts/service-ownership.ts" record "${UNIT_PATH}"

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
