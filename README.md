# Live Counter for OBS

## What this is

Live Counter is a big, easy-to-read number you can control from inside OBS and show on screen — for counting things up or down live, like "Hallelujah" shouted 50 times, or any other running count during a service or stream.

Everything lives inside OBS itself:

- A **control panel** (a dock you add inside OBS) with big +1 / −1 buttons, Undo, Jump to a number, Show/Hide, and more.
- A **transparent overlay** (a Browser Source) that shows the number on screen.
- A small **script** that lets you use real keyboard shortcuts (or a Stream Deck) for +1, −1, Undo, Pause/Resume, and Show/Hide.

There is nothing to install and no separate program to run — it's a folder of files plus a few clicks inside OBS, done once.

## Requirements

- OBS Studio 31 or newer (developed and tested against OBS 32).
- Windows or macOS.
- No internet connection is needed at any point — everything runs locally, inside OBS.

## One-time setup

First, copy the whole `live-counter` folder onto the streaming computer, anywhere you like (an external drive works too, as long as it stays connected). Then:

1. Double-click `dist/setup.html` — it opens in your normal web browser and shows the exact addresses for the two OBS pages on THIS computer, each with a Copy button. Keep this page open; you'll copy from it in the steps below.
2. In OBS: **Tools → WebSocket Server Settings** → turn the server **on**. Leave "Enable Authentication" checked. Note the port (usually 4455) and the password.
3. In OBS: **Docks → Custom Browser Docks** → add a new dock, pasting in the **Dock URL** from `setup.html`. Give it a name like "Live Counter".
4. In the new dock, open the **Diagnostics** tab and paste the websocket password from step 2 into the Password field, then click Save. The checklist should turn green once connected.
5. In OBS: add a **Browser Source** to your scene using the **Overlay URL** from `setup.html` — or, easier, go back to the dock's Diagnostics tab and click **"Add overlay to my scene"**, which creates it for you with the right settings already applied.
6. In OBS: **Tools → Scripts** → click the "+" → choose `counter-hotkeys.lua` from the folder you copied above. Then go to **Settings → Hotkeys**, scroll down to the five "Live Counter" entries, and assign whichever keys you'd like (see the Hotkeys section below for suggestions).

That's it. The dock's Diagnostics tab shows a running checklist confirming each piece is connected, and names the exact fix if anything isn't.

## Hotkeys

Hotkeys are set up in two places:

1. **Install the script once**: OBS → **Tools → Scripts** → "+" → select `counter-hotkeys.lua` from the project folder.
2. **Assign keys**: OBS → **Settings → Hotkeys** → scroll to the five entries starting with "Live Counter:" and click into each field, then press the key combination you want.

Bare keys (like plain `+` or `-`) can accidentally trigger while typing into an unrelated text field elsewhere in OBS, so a modifier combination is recommended for every one:

| Action | Suggested combo |
| --- | --- |
| +1 | ⌘/Ctrl + = |
| −1 | ⌘/Ctrl + − |
| Undo | ⌘/Ctrl + Z |
| Pause / Resume | ⌘/Ctrl + P |
| Show / Hide overlay | ⌘/Ctrl + H |

You don't have to use these exact combos — any modifier combination that isn't already used elsewhere in OBS works fine. Each hotkey is independent and optional; only bind the ones you actually plan to use.

Once assigned, these hotkeys work exactly like any other OBS hotkey — including through a Stream Deck's OBS integration.

## Daily use

1. Open (or load) a preset in the **Presets** tab, or configure a one-off count in **Setup**, then click **Start session**.
2. Click **Show** to make the overlay visible on screen (bring the scene to Program in OBS as usual).
3. Use **+1 / −1 / Undo / Jump to** as needed. At either end of the range, the count simply won't go further — nothing breaks.
4. If you're using Automatic mode, use **Pause / Resume / Faster / Slower / Reverse** as needed.
5. When you're done, **Hide** the overlay or **End session**.

## If something breaks

- **The dock looks stuck or frozen:** reload the dock (right-click it → Reload, or close and reopen it from Docks). It reads the current count back from storage and keeps going — nothing is lost.
- **OBS crashes or you have to restart it:** on reopening OBS, the dock restores your last session, paused, so you can check the number is right before continuing. Nothing is lost.
- **OBS asks "Are you sure you want to exit?" when quitting:** that's OBS's own normal exit-confirmation dialog, not a Live Counter warning — it's safe to confirm, your session is already saved.
- **Something looks properly wrong (wrong numbers, stuck settings, etc.):** open the dock's **Diagnostics** tab and use **"Reset everything"**. This is guarded by a confirmation naming exactly what it deletes (settings, presets, sessions, and logs on this device) — it cannot be undone, so only use it as a last resort.
- **Still stuck:** the Diagnostics tab has a **"Copy diagnostics"** button — copy it and share it with whoever's helping you troubleshoot.

## Moving to another computer

Just copy the whole project folder to the new computer and repeat **One-time setup** above — the dock/overlay addresses are different on every computer, which is exactly why `setup.html` exists (it always shows the correct addresses for wherever it's opened).

Your presets don't automatically come along, though — use the **Presets** tab's **Export** button on the old computer to copy them to your clipboard, then **Import** on the new one to bring them across.
