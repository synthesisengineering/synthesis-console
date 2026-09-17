#!/usr/bin/env bash

# Resolve the stdlib Python used to prepare Console's isolated dependency runtime.

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
      "$1" -I -B -c \
        'import os, sys; print(os.path.abspath(sys.executable)); sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
        2>/dev/null
    )" || return 1
    [[ -n "${resolved}" && "${resolved}" != *$'\n'* ]] || return 1
    resolved="$(absolute_executable "${resolved}" || true)"
    [[ -n "${resolved}" && -x "${resolved}" ]] || return 1
    "${resolved}" -I -B -c \
      'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
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
    echo "Error: SYNTHESIS_PYTHON_BIN does not name an executable Python 3.9+: ${SYNTHESIS_PYTHON_BIN}" >&2
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

# Setup needs only stdlib Python. PyYAML is supplied by the verified package.
console_bootstrap_python() {
  SYNTHESIS_PYTHON_BIN="${SYNTHESIS_BOOTSTRAP_PYTHON:-${SYNTHESIS_PYTHON_BIN:-}}" find_synthesis_python
}

provision_synthesis_python() {
  local candidate
  candidate="$(console_bootstrap_python)" || return 1
  "${candidate}" -I -B "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/python-runtime.py" setup
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    setup) candidate="$(console_bootstrap_python)" || exit 2 ;;
    resolve) candidate="${SYNTHESIS_BOOTSTRAP_PYTHON:-python3}" ;;
    *) echo 'Expected setup or resolve' >&2; exit 2 ;;
  esac
  exec "${candidate}" -I -B "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/python-runtime.py" "$1"
fi
