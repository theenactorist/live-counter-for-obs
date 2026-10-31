#!/bin/bash
# Double-click to remove Live Counter for OBS (T3). Terminal starts in the
# home folder, so go to this file's own folder first.
cd "$(dirname "$0")" || exit 1
/bin/bash ./installer/mac/uninstall.sh
status=$?
echo
printf 'Press Enter to close this window.'
read -r _
echo
exit "$status"
