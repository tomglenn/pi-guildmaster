#!/usr/bin/env bash
# Link the Guildmaster extension into Pi's global extension directory for
# development. Pi auto-discovers ~/.pi/agent/extensions/*/index.ts and supports
# hot-reload via /reload, so edits to src/ take effect without reinstalling.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_DIR}/src"
EXT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}/extensions"
LINK="${EXT_DIR}/guildmaster"

mkdir -p "${EXT_DIR}"
ln -sfn "${SRC_DIR}" "${LINK}"

echo "Linked: ${LINK} -> ${SRC_DIR}"
echo "Start pi and run /guild to verify (or /reload if already running)."
