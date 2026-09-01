#!/usr/bin/env bash
set -euo pipefail
UUID="shamsi-calendar@gnome.scr.ir"
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Removed $UUID"
