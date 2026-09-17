#!/bin/bash
# launch.sh — wrapper invoked by the macOS LaunchAgent.
#
# Reads Slack tokens from the macOS Keychain at launch and exports them as
# env vars before exec'ing the bun process. Avoids holding tokens in cleartext
# inside the LaunchAgent plist (which is mode 600 but is indexed by Spotlight
# and backed up by Time Machine).
#
# Token storage convention:
#   service: synthesis-console-slack-<source-name>   (e.g. synthesis-console-slack-personal)
#   account: $USER
#   password: the xoxp- token
#
# Manifest format (~/.synthesis/keychain-tokens.txt):
#   <service-name>:<env-var-name>
#   one entry per line; setup-slack writes/maintains this file.
#
# This script intentionally fails open: if the manifest is missing or empty,
# or a token can't be fetched, the bun process still launches — Slack send
# will be disabled until tokens are restored, but the rest of the console
# (project browser, daily plans, etc.) keeps working.

set -uo pipefail

USER_NAME="${USER:-$(whoami)}"
MANIFEST="$HOME/.synthesis/keychain-tokens.txt"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

if [ -f "$MANIFEST" ]; then
  while IFS=: read -r service env_name || [ -n "$service" ]; do
    # Skip blank lines and comments.
    [ -z "$service" ] && continue
    case "$service" in \#*) continue ;; esac
    [ -z "$env_name" ] && continue

    token="$(security find-generic-password -a "$USER_NAME" -s "$service" -w 2>/dev/null || true)"
    if [ -n "$token" ]; then
      export "$env_name=$token"
    fi
  done < "$MANIFEST"
fi

# Working directory is set by the LaunchAgent plist's WorkingDirectory key,
# so cd is unnecessary. Exec replaces this shell with bun, no orphan process.
exec "$BUN_BIN" run scripts/console-cli.ts start
