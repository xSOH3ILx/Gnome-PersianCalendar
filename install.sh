#!/usr/bin/env bash
set -euo pipefail
UUID="shamsi-calendar@gnome.scr.ir"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp -r src/* "$DEST/"
glib-compile-schemas "$DEST/schemas"
echo "Installed to: $DEST"
echo "On Wayland, log out and back in, then run:"
echo "  gnome-extensions enable $UUID"
