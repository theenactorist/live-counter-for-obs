#!/bin/bash
# Double-click to install Live Counter for OBS (T3). Terminal starts in the
# home folder, so go to this file's own folder first: install.sh then finds
# the Live Counter files beside it and downloads nothing.
cd "$(dirname "$0")" || exit 1
/bin/bash ./installer/mac/install.sh
status=$?
echo
printf 'Press Enter to close this window.'
read -r _
echo
exit "$status"
