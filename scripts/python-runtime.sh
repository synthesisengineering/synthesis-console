#!/usr/bin/env bash

# Resolve the exact Python interpreter used by the Console's synthesis tools.
# Those tools import PyYAML, so a Python executable alone is not sufficient.

find_synthesis_python() {
  local candidate
  local resolved
  local seen=":"

  absolute_executable() {
    local executable="$1"
    local directory
    if [[ "${executable}" == */* ]]; then
      directory="$(cd "$(dirname "${executable}")" 2>/dev/null && pwd -P)" || return 1
      printf '%s/%s\n' "${directory}" "$(basename "${executable}")"
    else
      command -v "${executable}"
    fi
  }

  resolved_compatible_python() {
    resolved="$(
      "$1" -c \
        'import os, sys, yaml; print(os.path.abspath(sys.executable)); sys.exit(0 if sys.version_info.major == 3 else 1)' \
        2>/dev/null
    )" || return 1
    [[ -n "${resolved}" && "${resolved}" != *$'\n'* ]] || return 1
    resolved="$(absolute_executable "${resolved}" || true)"
    [[ -n "${resolved}" && -x "${resolved}" ]] || return 1
    "${resolved}" -c \
      'import sys, yaml; raise SystemExit(0 if sys.version_info.major == 3 else 1)' \
      >/dev/null 2>&1 || return 1
    printf '%s\n' "${resolved}"
  }

  if [[ -n "${SYNTHESIS_PYTHON_BIN:-}" ]]; then
    candidate="$(absolute_executable "${SYNTHESIS_PYTHON_BIN}" || true)"
    if [[ -n "${candidate}" && -x "${candidate}" ]] && \
      resolved="$(resolved_compatible_python "${candidate}" || true)" && \
      [[ -n "${resolved}" ]]; then
      printf '%s\n' "${resolved}"
      return 0
    fi
    echo "Error: SYNTHESIS_PYTHON_BIN does not name an executable Python 3 with PyYAML: ${SYNTHESIS_PYTHON_BIN}" >&2
    return 1
  fi

  while IFS= read -r candidate; do
    candidate="$(absolute_executable "${candidate}" || true)"
    [[ -n "${candidate}" && -x "${candidate}" ]] || continue
    case "${seen}" in
      *":${candidate}:"*) continue ;;
    esac
    seen="${seen}${candidate}:"
    resolved="$(resolved_compatible_python "${candidate}" || true)"
    if [[ -n "${resolved}" ]]; then
      printf '%s\n' "${resolved}"
      return 0
    fi
  done < <(
    type -a -p python3 2>/dev/null || true
    printf '%s\n' \
      "${HOME}/.local/bin/python3" \
      "${HOME}/.pyenv/shims/python3" \
      "/Library/Frameworks/Python.framework/Versions/Current/bin/python3" \
      "/opt/homebrew/bin/python3" \
      "/usr/local/bin/python3" \
      "/usr/bin/python3"
  )

  return 1
}
