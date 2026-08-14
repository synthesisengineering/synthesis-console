#!/usr/bin/env bash
#
# Install Synthesis Console as a macOS LaunchAgent so it starts on login.
#
# Creates ~/Library/LaunchAgents/org.synthesisengineering.console.plist,
# loads it into launchd, and writes logs to ~/Library/Logs/synthesis-console/.
#
# Idempotent: if already installed, the plist is regenerated and reloaded.
# Uninstall with: scripts/uninstall-autostart-macos.sh

set -euo pipefail

LABEL="org.synthesisengineering.console"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/synthesis-console"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: This script is for macOS. For Linux, use install-autostart-linux.sh." >&2
  exit 1
fi

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "${HOME}/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
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

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "Error: Dependencies not installed. Run 'bun install' in ${REPO_ROOT} first." >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
mkdir -p "$(dirname "${PLIST_PATH}")"

PRIVATE_CONTROL_PLANE_XML=""
if [[ "${SYNTHESIS_PRIVATE_CONTROL_PLANE:-0}" == "1" ]]; then
  PRIVATE_CONTROL_PLANE_XML=$'        <key>SYNTHESIS_PRIVATE_CONTROL_PLANE</key>\n        <string>1</string>'
fi

LAUNCH_WRAPPER="${REPO_ROOT}/scripts/launch.sh"
chmod +x "${LAUNCH_WRAPPER}" 2>/dev/null || true

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LAUNCH_WRAPPER}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "${BUN_BIN}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>BUN_BIN</key>
        <string>${BUN_BIN}</string>
${PRIVATE_CONTROL_PLANE_XML}
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

echo "Wrote plist: ${PLIST_PATH}"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  # launchctl bootout is asynchronous; wait for the service to fully unload
  # before bootstrapping the new plist, otherwise bootstrap races and fails.
  for _ in $(seq 1 25); do
    if ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}" 2>/tmp/synthesis-console-bootstrap.err; then
  echo "Loaded via launchctl bootstrap."
else
  ERR="$(cat /tmp/synthesis-console-bootstrap.err 2>/dev/null || true)"
  echo "launchctl bootstrap failed: ${ERR}" >&2
  echo "Falling back to legacy launchctl load..." >&2
  launchctl load -w "${PLIST_PATH}"
  echo "Loaded via launchctl load (legacy)."
fi
rm -f /tmp/synthesis-console-bootstrap.err

launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true

# Verify the service is actually running (launchd reports state=running).
RUNNING=0
for _ in $(seq 1 25); do
  if launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -qE '^\s*state = running'; then
    RUNNING=1
    break
  fi
  sleep 0.2
done
if [[ "${RUNNING}" -ne 1 ]]; then
  echo "Warning: service did not reach running state. Check ${LOG_DIR}/stderr.log." >&2
fi

echo ""
echo "Synthesis Console is installed to start on login."
echo "  Label:   ${LABEL}"
echo "  Repo:    ${REPO_ROOT}"
echo "  Bun:     ${BUN_BIN}"
echo "  Logs:    ${LOG_DIR}/{stdout,stderr}.log"
echo ""
echo "It should already be running. Try: open http://localhost:5555"
echo "Uninstall with: ${REPO_ROOT}/scripts/uninstall-autostart-macos.sh"
