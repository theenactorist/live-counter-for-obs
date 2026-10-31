#!/bin/bash
# Live Counter for OBS: Mac uninstaller (T3).
#
# Run it with OBS closed, any of these ways:
#   curl -fsSL <install page>/uninstall.sh | bash
#   double-click "Uninstall Live Counter.command" in the release folder
#   bash installer/mac/uninstall.sh
#
# It removes only what install.sh added:
#   - every Custom Browser Dock whose address points into the install folder
#     (the "Live Counter" dock), from user.ini;
#   - every script entry, in every scene collection, whose path points into
#     the install folder (a copy loaded by hand from elsewhere stays);
#   - the install folder, ~/Library/Application Support/obs-studio/live-counter/.
# It leaves the WebSocket server on and every Browser Source alone, and says
# so. Before changing a file it saves a copy next to it, as
# <file>.live-counter-backup-<yyyymmdd-hhmmss>; any failure puts the copies
# back.
#
# Test-only overrides, as in install.sh: LC_OBS_CONFIG_DIR, LC_OBS_PROCESS,
# LC_TEST_FAIL_AFTER (collections or dock).
#
# Bash 3.2 and built-in macOS tools only; main runs on the last line.

CFG=""
INSTALL_DIR=""
WORK=""
TS=""
FAILING=0
BACKED_UP=()

say() {
  printf '%s\n' "$*"
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

undo() {
  local f
  for f in ${BACKED_UP[@]+"${BACKED_UP[@]}"}; do
    if [ -f "$f.live-counter-backup-$TS" ]; then
      mv -f "$f.live-counter-backup-$TS" "$f"
    fi
  done
}

fail() {
  if [ "$FAILING" = 1 ]; then
    exit 1
  fi
  FAILING=1
  say ""
  say "$1"
  undo
  say "Nothing was changed: your OBS settings are as they were."
  cleanup
  exit 1
}

fault_point() {
  if [ "${LC_TEST_FAIL_AFTER:-}" = "$1" ]; then
    fail "Test stop after the $1 step (LC_TEST_FAIL_AFTER). Run this again without it."
  fi
}

jxa() {
  local script="$1"
  shift
  /usr/bin/osascript -l JavaScript "$WORK/$script" "$@" 2>"$WORK/jxa-error.txt"
}

have_terminal() {
  { : </dev/tty; } 2>/dev/null
}

wait_for_obs_to_quit() {
  local name="${LC_OBS_PROCESS:-OBS}"
  while /usr/bin/pgrep -x "$name" >/dev/null 2>&1; do
    if ! have_terminal; then
      fail "OBS is open. Please quit OBS, then run this again."
    fi
    say "Please quit OBS, then press Enter."
    read -r _ </dev/tty || fail "OBS is open. Please quit OBS, then run this again."
  done
}

pick_timestamp() {
  local f taken
  while :; do
    TS=$(date +%Y%m%d-%H%M%S)
    taken=0
    for f in "$CFG"/*.live-counter-backup-"$TS" "$CFG"/basic/scenes/*.live-counter-backup-"$TS"; do
      if [ -e "$f" ]; then
        taken=1
      fi
    done
    if [ "$taken" = 0 ]; then
      break
    fi
    sleep 1
  done
}

backup() {
  local f="$1"
  cp -p "$f" "$f.live-counter-backup-$TS" ||
    fail "Could not save a copy of $f. Check the free disk space, then run this again."
  BACKED_UP+=("$f")
}

remove_scripts() {
  local f
  for f in "$CFG"/basic/scenes/*.json; do
    if [ -f "$f" ]; then
      backup "$f"
      jxa collection.js "$f" "$INSTALL_DIR" >/dev/null ||
        fail "Could not read the scene collection $(basename "$f"). Open OBS, choose that collection in the Scene Collection menu so OBS saves it again, quit OBS, then run this again."
    fi
  done
  say "Removed the hotkey script from every scene collection."
}

remove_dock() {
  if [ -f "$CFG/user.ini" ]; then
    backup "$CFG/user.ini"
    jxa userini.js "$CFG/user.ini" "$INSTALL_DIR" >/dev/null ||
      fail "Could not read the Custom Browser Docks list in $CFG/user.ini. Open OBS, open Docks → Custom Browser Docks, click Apply, quit OBS, then run this again."
  fi
  say "Removed the Live Counter panel from OBS."
}

finish() {
  local f
  for f in ${BACKED_UP[@]+"${BACKED_UP[@]}"}; do
    if cmp -s "$f" "$f.live-counter-backup-$TS"; then
      rm -f "$f.live-counter-backup-$TS"
    fi
  done
  rm -rf "$INSTALL_DIR"
  say "Removed the Live Counter files."
}

write_helpers() {
  cat >"$WORK/common.js" <<'JXA'
ObjC.import('Foundation');
function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error('cannot read ' + p);
  return s.js.replace(/^﻿/, '');
}
function writeText(p, t) {
  if (!$(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null)) throw new Error('cannot write ' + p);
}
function isObject(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function inside(child, folder) { return typeof child === 'string' && child.indexOf(folder.replace(/\/$/, '') + '/') === 0; }
JXA

  # argv: collection path, install folder. Drops script entries inside it.
  cat "$WORK/common.js" - >"$WORK/collection.js" <<'JXA'
function run(argv) {
  var j = JSON.parse(readText(argv[0])), folder = argv[1];
  if (!isObject(j)) throw new Error('not an object');
  var list = isObject(j.modules) ? j.modules['scripts-tool'] : undefined;
  if (!Array.isArray(list)) return 'unchanged';
  var kept = list.filter(function (e) { return !(isObject(e) && inside(e.path, folder)); });
  if (kept.length === list.length) return 'unchanged';
  j.modules['scripts-tool'] = kept;
  writeText(argv[0], JSON.stringify(j, null, 4));
  return 'changed';
}
JXA

  # argv: user.ini path, install folder. Drops docks whose address is inside it.
  cat "$WORK/common.js" - >"$WORK/userini.js" <<'JXA'
function run(argv) {
  var path = argv[0], folderUrl = $.NSURL.fileURLWithPathIsDirectory(argv[1], true).absoluteString.js;
  var text = readText(path), nl = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  var lines = text.split(/\r?\n/), section = false, i;
  for (i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) section = lines[i].trim() === '[BasicWindow]';
    else if (section && lines[i].indexOf('ExtraBrowserDocks=') === 0) break;
  }
  if (i === lines.length) return 'unchanged';
  var value = lines[i].slice('ExtraBrowserDocks='.length).trim();
  var list = value === '' ? [] : JSON.parse(value);
  if (!Array.isArray(list)) throw new Error('ExtraBrowserDocks is not a list');
  var kept = list.filter(function (o) { return !(isObject(o) && typeof o.url === 'string' && o.url.indexOf(folderUrl) === 0); });
  if (kept.length === list.length) return 'unchanged';
  // OBS's own spacing for this line.
  lines[i] = 'ExtraBrowserDocks=[' + kept.map(function (o) {
    return '{' + Object.keys(o).map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(o[k]); }).join(', ') + '}';
  }).join(', ') + ']';
  writeText(path, lines.join(nl));
  return 'changed';
}
JXA
}

main() {
  trap cleanup EXIT
  trap 'fail "Stopped before the end."' INT TERM
  say "Live Counter for OBS: uninstaller"
  if [ "$(uname -s)" != "Darwin" ]; then
    fail "This uninstaller is for a Mac. On Windows, use Uninstall Live Counter.bat."
  fi
  CFG="${LC_OBS_CONFIG_DIR:-$HOME/Library/Application Support/obs-studio}"
  INSTALL_DIR="$CFG/live-counter"
  if [ ! -d "$CFG" ]; then
    say "OBS has no settings folder on this Mac, so there is nothing to remove."
    say "Done."
    return 0
  fi
  wait_for_obs_to_quit
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/live-counter.XXXXXX") ||
    fail "Could not make a temporary folder. Restart the Mac, then run this again."
  write_helpers
  pick_timestamp

  say "Saving copies of the OBS settings it changes, then removing Live Counter..."
  remove_scripts
  fault_point collections
  remove_dock
  fault_point dock
  finish

  say ""
  say "The WebSocket server stays on. Turn it off in Tools → WebSocket Server Settings if nothing else uses it."
  say "Delete the Live Counter Overlay source in OBS if you no longer need it."
  say "Done. Open OBS."
}

main "$@"
