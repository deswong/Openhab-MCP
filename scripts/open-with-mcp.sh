#!/usr/bin/env bash
# Open VS Code with the OpenHAB folder and this MCP repository as a multi-root setup.
# Usage: open-with-mcp.sh /path/to/openhab

set -euo pipefail

if [ "${1-}" = "" ]; then
  echo "Usage: $0 /path/to/openhab"
  exit 2
fi

OPENHAB_PATH="$1"

# Determine MCP path: use MCP_PATH env var if set, otherwise assume this script is in scripts/ under the MCP repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_MCP_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_PATH="${MCP_PATH:-$DEFAULT_MCP_PATH}"

if ! command -v code >/dev/null 2>&1; then
  echo "Error: 'code' CLI not found. Install 'code' (Command Palette → 'Shell Command: Install 'code' command in PATH')"
  exit 3
fi

echo "Opening VS Code with OpenHAB: $OPENHAB_PATH and MCP: $MCP_PATH"
code "$OPENHAB_PATH" --add "$MCP_PATH"
