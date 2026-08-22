#!/usr/bin/env bash
# Installs the agent-browser host preset into $DSH_HOME (default ~/.dsh).
# Run from the repository root, after pnpm install && pnpm run build:lib:*.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRESET_DIR="$DSH_HOME/.agent-presets/agent-browser"
SHIPPED="apps/cli/config/agent-presets/standard/agent.cordis.yml"
FRAGMENT="contrib/agent-browser/agent-browser.patch.yml"

mkdir -p "$PRESET_DIR"

if [ ! -f "$PRESET_DIR/agent.cordis.yml" ]; then
  cp "$SHIPPED" "$PRESET_DIR/agent.cordis.yml"
  echo "copied standard preset -> $PRESET_DIR/agent.cordis.yml"
fi
[ -f "$PRESET_DIR/preset.yml" ] || cp contrib/agent-browser/preset.yml "$PRESET_DIR/preset.yml"

if grep -q "name: '@deepseek-ai/dsh-agent-browser'" "$PRESET_DIR/agent.cordis.yml"; then
  echo "agent-browser row already present"
else
  { echo; cat "$FRAGMENT"; } >> "$PRESET_DIR/agent.cordis.yml"
  echo "appended agent-browser row"
fi

echo "done. Restart 'dsh web' and open a session with the 'Agent Browser' preset."
