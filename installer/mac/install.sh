#!/bin/bash
# Live Counter for OBS: Mac installer (T3).
#
# Run it with OBS closed, any of these ways:
#   curl -fsSL <install page>/install.sh | bash
#   double-click "Install Live Counter.command" in the unzipped release folder
#   bash installer/mac/install.sh
#
# What it does, in the order proven in docs/installer-spike.md (T1):
#   1. Checks, changing nothing: macOS, OBS 31 or later in /Applications or
#      ~/Applications, OBS opened once (its settings folder and user.ini
#      exist), OBS not running (asks the operator to quit it, never forces it).
#   2. Copies the Live Counter files into
#      ~/Library/Application Support/obs-studio/live-counter/ (built beside it,
#      then swapped in), so the dock, overlay and script paths never change.
#   3. Saves a copy of each OBS file it may change, next to it, as
#      <file>.live-counter-backup-<yyyymmdd-hhmmss>. Copies of files that end
#      up unchanged are removed again at the end.
#   4. obs-websocket config.json: server on, authentication on, the existing
#      password kept (a 16-character one is made only if there is none).
#   5. live-counter/live-counter-config.js, the dock's connection file (format
#      in src/dock/installer-config.ts), owner-only.
#   6. Every scene collection: adds counter-hotkeys.lua, or repoints an
#      existing entry for it and keeps its saved keys, leaving one entry.
#   7. user.ini: adds the "Live Counter" dock, or repoints the existing one
#      and keeps its uuid.
#   8. Reads every changed file back. Any failure puts every copy back.
#
# The WebSocket password never leaves the small JavaScript (JXA) steps: it is
# never in a command line, a variable of this script, or the output.
#
# Where the Live Counter files come from, first match wins:
#   LC_ZIP=<path to a release zip>     (tests, and the real-OBS install walk)
#   the release folder this script sits in (installer/mac/ inside it)
#   a download of LC_ZIP_URL, by default the latest GitHub release.
#
# Overrides for tests only; an operator never sets these:
#   LC_OBS_CONFIG_DIR   the OBS settings folder
#   LC_OBS_APP          the OBS.app to read the version from
#   LC_OBS_PROCESS      the process name that means OBS is running
#   LC_ZIP_URL          the download address
#   LC_TEST_FAIL_AFTER  stop with a failure after a step: files, websocket,
#                       collections or dock
#
# Bash 3.2 and built-in macOS tools only. Everything is inside functions and
# main runs on the last line, so a download cut short runs nothing.

LC_TITLE="Live Counter"
LC_DEFAULT_ZIP_URL="https://github.com/theenactorist/live-counter-for-obs/releases/latest/download/live-counter-for-obs.zip"
LC_REQUIRED_FILES="dock.html overlay.html counter-hotkeys.lua"
LC_OPTIONAL_FILES="setup.html inter-OFL-LICENSE.txt oswald-OFL-LICENSE.txt"

CFG=""
INSTALL_DIR=""
NEW_DIR=""
OLD_DIR=""
WORK=""
SRC=""
TS=""
REVISION=""
FAILING=0
PLACED=0
MOVED_OLD=0
BACKED_UP=()
CREATED=()
CREATED_DIRS=()

say() {
  printf '%s\n' "$*"
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

# Puts back everything this run changed: the backed-up OBS files, files it
# created, and the install folder as it was.
undo() {
  local f
  for f in ${BACKED_UP[@]+"${BACKED_UP[@]}"}; do
    if [ -f "$f.live-counter-backup-$TS" ]; then
      mv -f "$f.live-counter-backup-$TS" "$f"
    fi
  done
  for f in ${CREATED[@]+"${CREATED[@]}"}; do
    rm -f "$f"
  done
  for f in ${CREATED_DIRS[@]+"${CREATED_DIRS[@]}"}; do
    rmdir "$f" 2>/dev/null
  done
  if [ "$PLACED" = 1 ]; then
    rm -rf "$INSTALL_DIR"
  fi
  if [ "$MOVED_OLD" = 1 ] && [ -d "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$INSTALL_DIR"
  fi
  if [ -n "$NEW_DIR" ]; then
    rm -rf "$NEW_DIR"
  fi
}

# Prints what went wrong and how to fix it, puts everything back, and stops.
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

# Runs one of the JXA helpers written by write_helpers.
jxa() {
  local script="$1"
  shift
  /usr/bin/osascript -l JavaScript "$WORK/$script" "$@" 2>"$WORK/jxa-error.txt"
}

check_mac() {
  if [ "$(uname -s)" != "Darwin" ]; then
    fail "This installer is for a Mac. On Windows, use Install Live Counter.bat."
  fi
}

check_obs_app() {
  local app="${LC_OBS_APP:-}"
  if [ -z "$app" ]; then
    if [ -d "/Applications/OBS.app" ]; then
      app="/Applications/OBS.app"
    elif [ -d "$HOME/Applications/OBS.app" ]; then
      app="$HOME/Applications/OBS.app"
    fi
  fi
  if [ -z "$app" ] || [ ! -f "$app/Contents/Info.plist" ]; then
    fail "OBS is not in Applications. Install OBS Studio 31 or later from https://obsproject.com, open it once, quit it, then run this again."
  fi
  local version major
  version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist" 2>/dev/null)
  major="${version%%.*}"
  case "$major" in
    '' | *[!0-9]*)
      fail "Could not read the OBS version in $app. Reinstall OBS Studio from https://obsproject.com, then run this again."
      ;;
  esac
  if [ "$major" -lt 31 ]; then
    fail "This Mac has OBS $version. Live Counter needs OBS 31 or later. Update OBS from https://obsproject.com, open it once, quit it, then run this again."
  fi
  say "Found OBS $version."
}

check_settings_folder() {
  if [ ! -d "$CFG" ] || [ ! -f "$CFG/user.ini" ]; then
    fail "OBS has not saved its settings yet. Open OBS once, quit it, then run this again."
  fi
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

# A timestamp no earlier backup uses, so a quick second run never overwrites
# the first run's copies.
pick_timestamp() {
  local f taken
  while :; do
    TS=$(date +%Y%m%d-%H%M%S)
    taken=0
    for f in "$CFG"/*.live-counter-backup-"$TS" \
      "$CFG"/plugin_config/obs-websocket/*.live-counter-backup-"$TS" \
      "$CFG"/basic/scenes/*.live-counter-backup-"$TS"; do
      if [ -e "$f" ]; then
        taken=1
      fi
    done
    if [ "$taken" = 0 ]; then
      break
    fi
    sleep 1
  done
  REVISION=$(date -u +%Y-%m-%dT%H:%M:%SZ)
}

unpack_zip() {
  local zip="$1" dock
  mkdir -p "$WORK/unzipped"
  if ! /usr/bin/ditto -x -k "$zip" "$WORK/unzipped" 2>/dev/null; then
    fail "Could not open the Live Counter download. Download it again, then run this again."
  fi
  dock=$(/usr/bin/find "$WORK/unzipped" -maxdepth 3 -name dock.html -type f | head -n 1)
  if [ -z "$dock" ]; then
    fail "The Live Counter download has no dock.html. Download it again, then run this again."
  fi
  SRC=$(dirname "$dock")
}

find_source() {
  local here=""
  if [ -n "${LC_ZIP:-}" ]; then
    say "Using the Live Counter files in $LC_ZIP."
    unpack_zip "$LC_ZIP"
    return
  fi
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  fi
  if [ -n "$here" ] && [ -f "$here/../../dock.html" ]; then
    SRC=$(cd "$here/../.." && pwd)
    say "Using the Live Counter files in this folder."
    return
  fi
  local url="${LC_ZIP_URL:-$LC_DEFAULT_ZIP_URL}"
  say "Downloading Live Counter..."
  if ! /usr/bin/curl -fsSL "$url" -o "$WORK/live-counter-for-obs.zip"; then
    fail "Could not download Live Counter. Check the internet connection, then run this again."
  fi
  unpack_zip "$WORK/live-counter-for-obs.zip"
}

check_source() {
  local f
  for f in $LC_REQUIRED_FILES; do
    if [ ! -f "$SRC/$f" ]; then
      fail "The Live Counter files are incomplete ($f is missing). Download them again, then run this again."
    fi
  done
}

install_files() {
  local f
  say "Copying the Live Counter files into the OBS settings folder..."
  NEW_DIR="$CFG/live-counter.new"
  OLD_DIR="$CFG/live-counter.old"
  rm -rf "$NEW_DIR" "$OLD_DIR"
  mkdir "$NEW_DIR" || fail "Could not write to $CFG. Check that your Mac account can change that folder, then run this again."
  # An allowlist: a live-counter-config.js in a download is never copied.
  for f in $LC_REQUIRED_FILES $LC_OPTIONAL_FILES; do
    if [ -f "$SRC/$f" ]; then
      cp "$SRC/$f" "$NEW_DIR/$f" || fail "Could not copy $f into $CFG. Check the free disk space, then run this again."
    fi
  done
  if [ -d "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$OLD_DIR" || fail "Could not update $INSTALL_DIR. Run this again."
    MOVED_OLD=1
  fi
  mv "$NEW_DIR" "$INSTALL_DIR" || fail "Could not create $INSTALL_DIR. Run this again."
  NEW_DIR=""
  PLACED=1
}

backup() {
  local f="$1"
  cp -p "$f" "$f.live-counter-backup-$TS" ||
    fail "Could not save a copy of $f. Check the free disk space, then run this again."
  BACKED_UP+=("$f")
}

backup_obs_files() {
  local f
  say "Saving copies of the OBS settings it changes..."
  backup "$CFG/user.ini"
  if [ -f "$CFG/plugin_config/obs-websocket/config.json" ]; then
    backup "$CFG/plugin_config/obs-websocket/config.json"
  fi
  for f in "$CFG"/basic/scenes/*.json; do
    if [ -f "$f" ]; then
      backup "$f"
    fi
  done
}

setup_websocket() {
  local dir="$CFG/plugin_config/obs-websocket" outcome
  if [ ! -d "$CFG/plugin_config" ]; then
    mkdir "$CFG/plugin_config" && CREATED_DIRS+=("$CFG/plugin_config")
  fi
  if [ ! -d "$dir" ]; then
    mkdir "$dir" && CREATED_DIRS=("$dir" ${CREATED_DIRS[@]+"${CREATED_DIRS[@]}"})
  fi
  if [ ! -f "$dir/config.json" ]; then
    CREATED+=("$dir/config.json")
  fi
  # The connection file holds the password, so it is created owner-only.
  outcome=$(umask 077 && jxa websocket.js "$dir/config.json" "$INSTALL_DIR/live-counter-config.js" "$REVISION") ||
    fail "Could not read the OBS WebSocket settings ($dir/config.json). Open OBS, open Tools → WebSocket Server Settings, click OK, quit OBS, then run this again."
  chmod 600 "$INSTALL_DIR/live-counter-config.js" ||
    fail "Could not protect $INSTALL_DIR/live-counter-config.js. Run this again."
  case "$outcome" in
    created) say "Turned on the OBS WebSocket server with a new password." ;;
    generated) say "Turned on the OBS WebSocket server and made a password for it." ;;
    *) say "Turned on the OBS WebSocket server (password kept)." ;;
  esac
  say "Connected the Live Counter panel to OBS."
}

add_script_to_collections() {
  local f count=0
  for f in "$CFG"/basic/scenes/*.json; do
    if [ -f "$f" ]; then
      jxa collection.js "$f" "$INSTALL_DIR/counter-hotkeys.lua" >/dev/null ||
        fail "Could not read the scene collection $(basename "$f"). Open OBS, choose that collection in the Scene Collection menu so OBS saves it again, quit OBS, then run this again."
      count=$((count + 1))
    fi
  done
  if [ "$count" = 1 ]; then
    say "Added the hotkey script to 1 scene collection."
  else
    say "Added the hotkey script to $count scene collections."
  fi
}

add_dock() {
  jxa userini.js "$CFG/user.ini" "$INSTALL_DIR/dock.html" "$LC_TITLE" >/dev/null ||
    fail "Could not read the Custom Browser Docks list in $CFG/user.ini. Open OBS, open Docks → Custom Browser Docks, click Apply, quit OBS, then run this again."
  say "Added the Live Counter panel to OBS."
}

check_changes() {
  local f
  say "Checking the changes..."
  jxa verify-websocket.js "$CFG/plugin_config/obs-websocket/config.json" "$INSTALL_DIR/live-counter-config.js" >/dev/null ||
    fail "The OBS WebSocket settings did not save correctly. Run this again."
  jxa verify-dock.js "$CFG/user.ini" "$INSTALL_DIR/dock.html" "$LC_TITLE" >/dev/null ||
    fail "The Live Counter panel did not save correctly in $CFG/user.ini. Run this again."
  for f in "$CFG"/basic/scenes/*.json; do
    if [ -f "$f" ]; then
      jxa verify-collection.js "$f" "$INSTALL_DIR/counter-hotkeys.lua" >/dev/null ||
        fail "The scene collection $(basename "$f") did not save correctly. Run this again."
    fi
  done
}

# Keeps a backup only when its file really changed.
finish() {
  local f
  for f in ${BACKED_UP[@]+"${BACKED_UP[@]}"}; do
    if cmp -s "$f" "$f.live-counter-backup-$TS"; then
      rm -f "$f.live-counter-backup-$TS"
    fi
  done
  if [ "$MOVED_OLD" = 1 ]; then
    rm -rf "$OLD_DIR"
  fi
}

write_helpers() {
  cat >"$WORK/common.js" <<'JXA'
ObjC.import('Foundation');
function exists(p) { return $.NSFileManager.defaultManager.fileExistsAtPath(p); }
function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error('cannot read ' + p);
  return s.js.replace(/^﻿/, '');
}
function writeText(p, t) {
  if (!$(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null)) throw new Error('cannot write ' + p);
}
function isObject(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function readJson(p) {
  var j = JSON.parse(readText(p));
  if (!isObject(j)) throw new Error('not an object: ' + p);
  return j;
}
function baseName(p) { return String(p).split(/[\\/]/).pop(); }
function fileUrl(p) { return $.NSURL.fileURLWithPath(p).absoluteString.js; }
// OBS's own spacing for the ExtraBrowserDocks line.
function docksText(list) {
  return '[' + list.map(function (o) {
    return '{' + Object.keys(o).map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(o[k]); }).join(', ') + '}';
  }).join(', ') + ']';
}
// The [BasicWindow] ExtraBrowserDocks line of user.ini: where it is and its list.
function findDocks(lines) {
  var start = -1, end, at = -1, i;
  for (i = 0; i < lines.length; i++) if (lines[i].trim() === '[BasicWindow]') { start = i; break; }
  if (start < 0) return { start: -1, end: -1, at: -1, list: [] };
  for (end = start + 1; end < lines.length; end++) if (/^\s*\[/.test(lines[end])) break;
  for (i = start + 1; i < end; i++) if (lines[i].indexOf('ExtraBrowserDocks=') === 0) { at = i; break; }
  var list = [];
  if (at >= 0) {
    var value = lines[at].slice('ExtraBrowserDocks='.length).trim();
    if (value !== '') list = JSON.parse(value);
    if (!Array.isArray(list)) throw new Error('ExtraBrowserDocks is not a list');
  }
  return { start: start, end: end, at: at, list: list };
}
JXA

  # argv: config.json path, connection file path, revision. Prints created,
  # generated or kept. The password stays inside this step.
  cat "$WORK/common.js" - >"$WORK/websocket.js" <<'JXA'
function newPassword() {
  var out = '';
  while (out.length < 16) {
    var bytes = $.NSFileHandle.fileHandleForReadingAtPath('/dev/urandom').readDataOfLength(48);
    out += bytes.base64EncodedStringWithOptions(0).js.replace(/[^A-Za-z0-9]/g, '');
  }
  return out.slice(0, 16);
}
function run(argv) {
  var path = argv[0], connPath = argv[1], revision = argv[2], outcome = 'kept', cfg;
  if (exists(path)) {
    cfg = readJson(path);
  } else {
    cfg = { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_port: 4455 };
    outcome = 'created';
  }
  var before = JSON.stringify(cfg);
  cfg.server_enabled = true;
  cfg.auth_required = true;
  var port = cfg.server_port;
  if (typeof port !== 'number' || Math.floor(port) !== port || port < 1 || port > 65535) cfg.server_port = 4455;
  if (typeof cfg.server_password !== 'string' || cfg.server_password === '') {
    cfg.server_password = newPassword();
    if (outcome === 'kept') outcome = 'generated';
  }
  if (outcome === 'created' || JSON.stringify(cfg) !== before) writeText(path, JSON.stringify(cfg, null, 2) + '\n');
  writeText(connPath, 'window.LIVE_COUNTER_CONFIG = { port: ' + cfg.server_port + ', password: ' +
    JSON.stringify(cfg.server_password) + ', revision: ' + JSON.stringify(revision) + ' };\n');
  return outcome;
}
JXA

  # argv: collection path, script path. Adds the script, or repoints the
  # existing entry (keeping the one with saved keys) and leaves one.
  cat "$WORK/common.js" - >"$WORK/collection.js" <<'JXA'
function run(argv) {
  var path = argv[0], lua = argv[1];
  var j = readJson(path), before = JSON.stringify(j);
  if (j.modules === undefined) j.modules = {};
  if (!isObject(j.modules)) throw new Error('modules is not an object');
  var list = j.modules['scripts-tool'];
  if (list === undefined) list = [];
  if (!Array.isArray(list)) throw new Error('scripts-tool is not a list');
  function ours(e) { return isObject(e) && typeof e.path === 'string' && baseName(e.path) === baseName(lua); }
  var first = -1, keep = -1, i;
  for (i = 0; i < list.length; i++) {
    if (!ours(list[i])) continue;
    if (first < 0) first = i;
    if (keep < 0 && isObject(list[i].settings) && Object.keys(list[i].settings).length > 0) keep = i;
  }
  var result = [];
  if (first < 0) {
    result = list.concat([{ path: lua, settings: {} }]);
  } else {
    if (keep < 0) keep = first;
    var entry = list[keep];
    entry.path = lua;
    if (!isObject(entry.settings)) entry.settings = {};
    for (i = 0; i < list.length; i++) {
      if (!ours(list[i])) result.push(list[i]);
      else if (i === first) result.push(entry);
    }
  }
  j.modules['scripts-tool'] = result;
  if (JSON.stringify(j) === before) return 'unchanged';
  writeText(path, JSON.stringify(j, null, 4));
  return 'changed';
}
JXA

  # argv: user.ini path, dock.html path, dock title. Adds the dock or
  # repoints the one with that title, keeping its uuid.
  cat "$WORK/common.js" - >"$WORK/userini.js" <<'JXA'
function newUuid() { return $.NSUUID.UUID.UUIDString.js.replace(/-/g, '').toLowerCase(); }
function run(argv) {
  var path = argv[0], url = fileUrl(argv[1]), title = argv[2];
  var text = readText(path), nl = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  var lines = text.split(/\r?\n/);
  var d = findDocks(lines), list = d.list, found = null, i;
  for (i = 0; i < list.length; i++) if (isObject(list[i]) && list[i].title === title) { found = list[i]; break; }
  if (found) {
    if (found.url === url && typeof found.uuid === 'string' && found.uuid !== '') return 'unchanged';
    found.url = url;
    if (typeof found.uuid !== 'string' || found.uuid === '') found.uuid = newUuid();
  } else {
    list.push({ title: title, url: url, uuid: newUuid() });
  }
  var line = 'ExtraBrowserDocks=' + docksText(list);
  if (d.at >= 0) {
    lines[d.at] = line;
  } else if (d.start >= 0) {
    var at = d.end;
    while (at - 1 > d.start && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, line);
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '[BasicWindow]', line, '');
  }
  writeText(path, lines.join(nl));
  return 'changed';
}
JXA

  cat "$WORK/common.js" - >"$WORK/verify-websocket.js" <<'JXA'
function run(argv) {
  var cfg = readJson(argv[0]);
  if (cfg.server_enabled !== true || cfg.auth_required !== true) throw new Error('server or auth off');
  if (typeof cfg.server_password !== 'string' || cfg.server_password === '') throw new Error('no password');
  var conn = readText(argv[1]);
  var m = /^window\.LIVE_COUNTER_CONFIG = \{ port: (\d+), password: ("(?:[^"\\]|\\.)*"), revision: ("[^"]+") \};\n$/.exec(conn);
  if (!m || Number(m[1]) !== cfg.server_port || JSON.parse(m[2]) !== cfg.server_password) throw new Error('connection file');
  return 'ok';
}
JXA

  cat "$WORK/common.js" - >"$WORK/verify-dock.js" <<'JXA'
function run(argv) {
  var url = fileUrl(argv[1]), title = argv[2];
  var list = findDocks(readText(argv[0]).split(/\r?\n/)).list;
  var mine = list.filter(function (o) { return isObject(o) && o.title === title; });
  if (mine.length !== 1 || mine[0].url !== url) throw new Error('dock');
  return 'ok';
}
JXA

  cat "$WORK/common.js" - >"$WORK/verify-collection.js" <<'JXA'
function run(argv) {
  var j = readJson(argv[0]), lua = argv[1];
  var list = (j.modules || {})['scripts-tool'] || [];
  var mine = list.filter(function (e) { return isObject(e) && baseName(e.path) === baseName(lua); });
  if (mine.length !== 1 || mine[0].path !== lua) throw new Error('script entry');
  return 'ok';
}
JXA
}

main() {
  trap cleanup EXIT
  trap 'fail "Stopped before the end."' INT TERM
  say "Live Counter for OBS: installer"
  say "Checking this Mac..."
  check_mac
  CFG="${LC_OBS_CONFIG_DIR:-$HOME/Library/Application Support/obs-studio}"
  INSTALL_DIR="$CFG/live-counter"
  check_obs_app
  check_settings_folder
  wait_for_obs_to_quit
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/live-counter.XXXXXX") ||
    fail "Could not make a temporary folder. Restart the Mac, then run this again."
  write_helpers
  find_source
  check_source
  pick_timestamp

  install_files
  fault_point files
  backup_obs_files
  setup_websocket
  fault_point websocket
  add_script_to_collections
  fault_point collections
  add_dock
  fault_point dock
  check_changes
  finish

  say ""
  say "In OBS, the Live Counter panel opens on the right and connects by itself."
  say "Keys: Ctrl+Option with = adds one, - takes one away, Z undoes, P pauses, H shows or hides."
  say "To show the counter, click Add overlay in the panel and choose a scene."
  say "Done. Open OBS."
}

main "$@"
