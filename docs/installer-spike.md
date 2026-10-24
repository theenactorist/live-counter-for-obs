# Installer spike: OBS settings changes (T1)

Spike run on 2026-10-24 on the dev Mac: macOS Tahoe 26.6.2, Apple Silicon. OBS started the spike at 32.2.2 and updated itself to 33.0.0 when it was first quit (its own auto-update, see "Findings outside the plan"). obs-websocket 5.7.6. Every Mac change below was made with OBS quit, by a throwaway `osascript -l JavaScript` (JXA) script, and then checked in the real OBS. Windows lines come from OBS docs and source only and are all **unverified**.

The OBS settings folder was backed up first and restored at the end; after the restore the folder matched the backup file for file, and the dock reconnected with its saved password.

## What the installer changes

Paths are relative to the OBS settings folder: Mac `~/Library/Application Support/obs-studio/`, Windows `%APPDATA%\obs-studio\` (unverified).

| # | Change | File | Key | Shape | Proven on Mac | Windows (docs, unverified) | Risks |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | Add the Live Counter dock | `user.ini` | `[BasicWindow]` `ExtraBrowserDocks` | One-line JSON array of `{"title", "url", "uuid"}`. `uuid` is 32 lowercase hex characters, no dashes. `url` is a `file:///` URL with spaces as `%20`. | Yes, 32.2.2 and 33.0.0. The new dock appeared docked on the right edge of the main window on first launch and was still there, same place, after quit and reopen. OBS rewrote the line on quit with its own spacing (`", "`, `": "`) and kept the uuid. | Same key in `user.ini` (OBS 31.0 moved it out of `global.ini`). OBS writes `user.ini` with a UTF-8 BOM on Windows and strips a BOM on read. URL form `file:///C:/Users/.../dock.html`, from `([System.Uri]$path).AbsoluteUri`. uuid from `[guid]::NewGuid().ToString('N')`. | Match the existing entry by title `Live Counter` (the title the manual install uses) and update its URL; an operator who renamed the dock gets a second one. `user.ini` exists only after OBS has been opened once. `global.ini` still has a stale `ExtraBrowserDocks=[]` from before OBS 31: never write there. |
| 2 | Dock layout | `user.ini` | `[BasicWindow]` `DockState` | Base64 Qt `saveState`; each dock is keyed by `<title>_extraBrowser` | Yes: no entry needed. OBS placed the new dock itself and added `LC Probe_extraBrowser` to `DockState` on quit. | Same (unverified). | Do not write `DockState`. Keep the dock title fixed, because the saved position is tied to the title. |
| 3 | WebSocket server on, auth on, same password | `plugin_config/obs-websocket/config.json` | `server_enabled`, `auth_required`, `server_password`, `server_port`, `first_load`, `alerts_enabled` | Flat JSON object | Yes. With the file removed, OBS generated `server_enabled: false`, `auth_required: true`, `first_load: false`, port 4455 and a 16-character letters-and-digits password. With `server_enabled` set to true (password kept), a client authenticated; a wrong password was refused (close code 4009). OBS kept an unknown key and rewrote the file sorted with 2-space indent at startup. | Same keys and path. Command-line `--websocket_password` overrides are never written to disk. | Never set `auth_required` false. If `server_password` is empty, generate 16 letters and digits like OBS does. The file is not rewritten on quit, but obs-websocket reads it only at startup, and the Tools → WebSocket Server Settings dialog rewrites it on OK. |
| 4 | Which collection is current | `user.ini` | `[Basic]` `SceneCollection` (display name), `SceneCollectionFile` | Strings | Read only. | Same (unverified). | Not needed by the installer, because the script goes into every collection. The display name and file name can differ (`LC test` lives in `LC_test.json`). |
| 5 | Hotkey script in every collection | `basic/scenes/<name>.json`, one file per collection | `modules` → `"scripts-tool"` | Array of `{"path": "<absolute path>", "settings": {...}}` | Yes. The script loaded from the new folder in the current collection and, after switching collections, in a second collection (log line `Loaded lua script: counter-hotkeys.lua`). A path with spaces works unescaped. A collection with no scripts has no `scripts-tool` key at all. | Same shape. OBS stores forward slashes (`C:/Users/...`) because the path comes from a Qt file dialog. `obs_script_create` drops entries it cannot load, silently. Collection JSON is loaded with duplicate keys rejected. | Edit only `*.json`, never the `.bak` and `.v1` copies OBS keeps beside them. Match an existing entry by file name `counter-hotkeys.lua` (any folder) and repoint it, keeping its `settings`, so a manual install moves to the fixed folder without losing its keys. Keep one entry only: two entries load the script twice. |
| 6a | Suggested hotkeys, route A: write the arrays | same collection file | `settings` → `lc_inc_hotkey`, `lc_dec_hotkey`, `lc_undo_hotkey`, `lc_pause_resume_hotkey`, `lc_show_hide_hotkey` | Each an array of `{"control": true, "alt": true, "key": "OBS_KEY_EQUAL"}` (keys `OBS_KEY_EQUAL`, `OBS_KEY_MINUS`, `OBS_KEY_Z`, `OBS_KEY_P`, `OBS_KEY_H`) | Yes. In a second collection given only these arrays, Ctrl+Option+− sent `dec` through the command channel. `control` plus `alt` is Ctrl+Option on the Mac. | The same JSON means Ctrl+Alt on Windows (OBS uses the same modifier names on every OS). | Write a key only when it is missing. An empty array `[]` means the operator cleared that key on purpose, so leave it. |
| 6b | Suggested hotkeys, route B: the Lua script sets them | `counter-hotkeys.lua` (product change, T2) | none in files | In `script_load`, for each hotkey: if `obs_data_has_user_value(settings, "lc_x_hotkey")` is false, build the same one-item array and call `obs_hotkey_load` | Yes, with a throwaway copy of the script: with no saved settings the log read "default keys applied to 5 of 5" and Ctrl+Option+− fired; with all five saved as `[]` it read "0 of 5" and the key did nothing. On quit, `script_save` wrote the five default arrays into the collection, so the defaults stay put from then on. | Same Lua runs on Windows (unverified). | A test for "empty array" instead of `obs_data_has_user_value` would bring the keys back every launch after an operator clears them. OBS allows the same key on two hotkeys, so a key the operator already uses elsewhere would fire both. |
| 7 | Dock connection settings | new `live-counter/live-counter-config.js` next to `dock.html` | `window.LIVE_COUNTER_CONFIG` | `window.LIVE_COUNTER_CONFIG = { port: 4455, password: "<redacted>" };` | Yes: a probe page loaded from the fixed folder by `file://` in the real OBS dock read a `<script src="./probe-config.js">` beside it. A URL parameter (`?wsPw=`) also reached the page. | Same mechanism (unverified). | See "Dock connection seam" below. |
| 8 | Live Counter files | new folder `live-counter/` | none | `dock.html`, `overlay.html`, `counter-hotkeys.lua`, assets, `live-counter-config.js` | Yes, as `live-counter-probe/`: the dock loaded from `file:///Users/<user>/Library/Application%20Support/obs-studio/live-counter-probe/probe.html` and the script from the same folder. | `%APPDATA%\obs-studio\live-counter\`. Portable OBS keeps settings elsewhere (see Windows notes). | The folder sits inside OBS's settings folder, so it survives OBS app updates (proven: OBS updated to 33.0.0 mid-spike and the folder was untouched). |

## Recommended install folder

- Mac: `~/Library/Application Support/obs-studio/live-counter/`
- Windows: `%APPDATA%\obs-studio\live-counter\` (unverified). If OBS is in portable mode (a file named `portable_mode`, `obs_portable_mode`, `portable_mode.txt` or `obs_portable_mode.txt` in the OBS install root, two levels above `obs64.exe`), the settings folder is `<install root>\config\obs-studio\` instead; the installer should stop and say so rather than guess.

Each run replaces the folder's contents, so the dock URL, the overlay URL and the script path never change.

## Recommended hotkey route

**Route B, the Lua script sets the suggested keys when none are saved** (T2), and the installer does not write hotkey arrays. Reasons:

- One implementation for Mac, Windows and the manual install (`setup.html`, AC 32): anyone who loads the script gets the keys, with or without the installer.
- It also covers a scene collection the operator makes later and loads the script into by hand.
- `obs_data_has_user_value` gives the exact rule wanted: keys appear only when none were ever saved, and a key the operator cleared stays cleared.
- The installer only adds `{"path": ..., "settings": {}}` to collections that lack the script, and never touches existing `settings`.

Route A works too and needs no product change, but it puts the same rule in two installers (bash/JXA and PowerShell) and does nothing for the manual install.

## Dock connection seam

**Recommended: a classic script beside the dock, `live-counter-config.js`, setting `window.LIVE_COUNTER_CONFIG = { port, password }`.** Weighing:

| | Config script | URL parameter (`?wsPw=`) |
| :-- | :-- | :-- |
| Where the password ends up | One file in the install folder, next to obs-websocket's own `config.json`, which already holds it in plain text. | In `user.ini`, and in plain sight in Docks → Custom Browser Docks, a dialog operators open and screenshot when asking for help. Also in the remote-debugging page list. OBS did not write the dock URL to its log (checked). |
| Updates | The installer rewrites one file; the dock URL never changes. | The installer must rewrite `user.ini` whenever the password changes. |
| Uninstall | Deleting the folder removes it. | The password stays in `user.ini` history and backups until the dock entry is removed. |
| Missing or broken | A missing file is a failed script load: the dock falls back to its saved settings. | No param: same fallback. |

Proven facts that shape the rule:

- In OBS's browser, every `file://` page shares one origin. The probe page, loaded from the new folder, saw the real dock's localStorage keys (`lc.settings.v1`, `lc.session.v1` and others). So moving `dock.html` to the install folder keeps the operator's saved settings, session and presets.
- The same fact means the saved password was already readable by any local page OBS loads; the config script adds no new exposure.

Disagreement rule (for T2): the config carries a `revision` (the install time). The dock remembers the last revision it applied. When the revision is new, the installer has just run with OBS's real password, so the dock adopts the config values and saves them. Otherwise the operator's saved settings win, so a password typed in Setup after the install is not overwritten on every launch.

## Order of changes

1. Preflight, changing nothing:
   - Mac: OBS is installed (`/Applications/OBS.app` on this Mac; T3 decides how to find a bundle installed elsewhere); OBS version from `Contents/Info.plist` `CFBundleShortVersionString` is 31 or later.
   - The settings folder and `user.ini` exist. If not, ask the operator to open OBS once and quit it.
   - OBS is not running (see "OBS while installing").
2. Copy the Live Counter files into `live-counter/` (write to a temporary folder beside it, then swap).
3. Save a timestamped copy of each file about to change: `user.ini`, `config.json`, every `basic/scenes/*.json`.
4. WebSocket `config.json`: `server_enabled` true, `auth_required` true, keep `server_password` (generate one only if empty), keep every other key.
5. Write `live-counter/live-counter-config.js` from the values in step 4.
6. Every collection: add or repoint the `counter-hotkeys.lua` entry.
7. `user.ini`: add or update the `Live Counter` dock last, because it is the change the operator sees.
8. Read every changed file back and parse it; on any failure, put the step 3 copies back and name the fix. Then print "Done. Open OBS."

The files come first so the dock URL and script path point at real files, and the WebSocket step comes before the config script because the config script copies its password.

## OBS while installing

- **Edits while OBS runs are lost.** Edited while OBS was running: `user.ini` and the current collection file were rewritten on quit and the edits were gone. `config.json` was not rewritten on quit, so that edit survived, but obs-websocket reads it only at startup. So the installer must run with OBS closed, as the rules already say.
- **Mac process check: `pgrep -x OBS`** (or match `/Applications/OBS.app/Contents/MacOS/OBS`). Never `pgrep -i obs`: the OBS virtual camera extension (`com.obsproject.obs-studio.mac-camera-extension`) stays running while OBS is closed.
- **Asking OBS to quit on the Mac:** `osascript -e 'tell application "OBS" to quit'` closed OBS within about 2 seconds every time (5 of 5), but osascript reported `User canceled. (-128)` each time. Ignore its exit code and poll `pgrep -x OBS` instead.
- OBS asks before quitting only while streaming or recording (OBS source, `ConfirmOnExit`), so a polite quit during a live service waits on a dialog. The installer should ask the operator to quit OBS rather than quit it.
- **Windows process (unverified):** `obs64.exe`; `Get-Process obs64 -ErrorAction SilentlyContinue`. A polite close is `$p.CloseMainWindow()` then `WaitForExit(15000)`; when OBS is minimised to the tray, `CloseMainWindow()` can return false. Never `Stop-Process -Force`: OBS skips its save.

## Mac tools

- **JXA handles all of it on stock macOS.** `osascript -l JavaScript` read, changed and wrote every file in this spike: `user.ini` line by line, `config.json`, and full scene collections through `JSON.parse` and `JSON.stringify`. It uses `NSString` `writeToFile:atomically:` with UTF-8, which writes no BOM. No developer tools were needed.
- **A curl download carries no quarantine flag.** `/usr/bin/curl` (8.7.1) downloaded the v0.3.0 zip and a raw file with no extended attributes at all (`xattr -l` empty), and `curl | bash` never meets Gatekeeper. On this Mac `curl` in `PATH` is not Apple's (`/opt/anaconda3/bin/curl`), so `install.sh` should call `/usr/bin/curl` itself.
- **The zip keeps the run bit.** `npm run package` uses `zip -r -X`, which keeps it (`-rwxr-xr-x` in `zipinfo`), and Archive Utility kept it on extract.
- **Gatekeeper blocks the double-click.** A `.command` from a zip with Safari's quarantine flag is refused. Archive Utility copied the flag onto the extracted `.command`. `spctl --assess` gave "rejected, no usable signature". Double-clicking (`open`) showed this dialog, and the script did not run:
  - Title: "“Install Live Counter.command” Not Opened"
  - Text: "Apple could not verify “Install Live Counter.command” is free of malware that may harm your Mac or compromise your privacy."
  - Buttons: "Move to Trash" and "Done". There is no Open button. A "?" help button sits top right.
- **Getting past it (macOS 15 and later flow, not clicked here):**
  1. Click Done.
  2. Open System Settings → Privacy & Security and scroll to Security. It should name the file as blocked, with an Open Anyway button.
  3. Click Open Anyway and enter the Mac password.
  4. Double-click the file again and choose Open.

  Apple says Control-click → Open no longer skips the check on macOS 15 and later (unverified here). These steps were not clicked through (they change a security setting) and need one real run.
- **Not done: a real Safari download.** Safari, driven by a script, opened an off-screen window and downloaded nothing. The quarantine flag was set by hand in Safari's format (`0083;<time>;Safari;<uuid>`), which is what Gatekeeper checks.
- **Not seen: the Terminal "access your Downloads folder" prompt,** because the script never ran.

## Windows notes (all unverified, from docs and source)

- **Settings folder:** `%APPDATA%\obs-studio\` with the same relative paths. `user.ini` arrived in OBS 31.0. On first run of 31 or later, OBS copies `global.ini` to `user.ini` only if `user.ini` is missing.
- **Encoding:** OBS strips a UTF-8 BOM when reading ini and JSON, and writes a BOM itself to ini files on Windows. Never write UTF-16 (`Out-File` and `>` in PowerShell 5.1). Read with `[IO.File]::ReadAllText`. Write with `[IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding $false))`.
- **PowerShell 5.1 JSON:**
  - `ConvertTo-Json` defaults to `-Depth 2` and silently flattens deeper levels, so always pass `-Depth 100`. It escapes `< > & '` as `\u003c` and similar, which is valid JSON.
  - A one-item or empty array unrolls when piped, so use `ConvertTo-Json -InputObject @(...)`.
  - Keys that differ only by case make `ConvertFrom-Json` throw.
  - Round-tripping whole scene collections is the riskiest step, so check that the result parses before replacing the file.
- **Ini:** no built-in parser. Read lines, track `[Section]`, replace or insert only `ExtraBrowserDocks=` inside `[BasicWindow]`, and leave every other line alone.
- **Mark of the Web:** a downloaded zip carries a `Zone.Identifier` stream, and Explorer's Extract All copies it to every file. Right-click the zip → Properties → Unblock before extracting clears it, as does `Unblock-File`.
- **`.bat` double-click:** expect "Open File - Security Warning" ("The publisher could not be verified...", Run or Cancel) or the SmartScreen "Windows protected your PC" (More info → Run anyway). Windows 11 Smart App Control blocks a downloaded `.bat` outright.
- **`.ps1` double-click:** opens in an editor; it does not run.
- **Execution policy:** the default on Windows client editions is Restricted. A `.bat` that runs `powershell -ExecutionPolicy Bypass -File install.ps1` works without admin rights, unless Group Policy sets a policy.
- **`irm <url> | iex`:** not subject to execution policy, and the fetched text gets no Mark of the Web. AMSI and Defender still scan it.

## Findings outside the plan

- **OBS auto-updated itself mid-spike, 32.2.2 to 33.0.0.** The first launch showed "Updating OBS Studio: Extracting update..."; the update installed when OBS was quit. Everything after that ran on 33.0.0, and every change above worked on both. The OBS 33 update did not touch the probe folder inside the settings folder. AGENTS.md's target (31.x and 32.x) should add 33.x.
- On every launch this Mac shows a "Missing Files" dialog for a slide image in an existing scene. It is not related to Live Counter, and OBS still loads.
