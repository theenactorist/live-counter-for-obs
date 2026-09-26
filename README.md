# Live Counter for OBS

## What this is

Live Counter puts a large number on screen that you control from inside OBS. Use it to count up or down live, for example "Hallelujah" shouted 50 times, or any other running count during a service or stream.

It has three parts, all inside OBS:

- A **control panel** (a dock you add inside OBS) with +1 / −1, Undo, Jump to a number, Show/Hide and more.
- A **transparent overlay** (a Browser Source) that shows the number on screen.
- A small **script** that adds keyboard shortcuts (or Stream Deck buttons) for +1, −1, Undo, Pause/Resume and Show/Hide.

There is no program to install. It is a folder of files plus a one-time setup inside OBS.

For the same steps with pictures, open `install-guide/index.html` in the Live Counter folder.

## Requirements

- OBS Studio 31 or newer (developed and tested on OBS 32).
- Windows or macOS.
- No internet connection is needed. Everything runs on this computer, inside OBS.

## One-time setup

Copy the Live Counter folder (`live-counter-for-obs`) onto the streaming computer and put it somewhere permanent, such as Documents. An external drive works if it stays connected. OBS remembers the folder's exact location, so read "If you move or rename the folder" below before moving it later. Then:

1. Double-click `setup.html` in the Live Counter folder. It opens in your web browser and shows the two addresses OBS needs on this computer, each with a Copy button. Keep it open for the next steps.
2. In OBS: **Tools → WebSocket Server Settings**. Tick **Enable WebSocket server** and leave **Enable Authentication** ticked. Note the Server Port (usually 4455). Click **Show Connect Info** and copy the Server Password. Click Apply, then OK.
3. In OBS: **Docks → Custom Browser Docks**. In an empty row, type a name such as "Live Counter" and paste the **Dock URL** from `setup.html`. Click Apply.
4. The new dock opens on the **Live tab** with a **Connect to OBS** card. Check that the Port matches step 2, click **Paste** next to Password, then click **Connect**. You can also connect from the dock's **Diagnostics** tab: click Paste next to Password, then Save. The Diagnostics checklist turns green once the dock is connected.
5. Add the overlay. The easy way: put the scene for the counter in Program, open the dock's **Diagnostics** tab and click **Add overlay to my scene**. It creates the Browser Source with the right settings. The manual way: add a **Browser Source** to your scene using the **Overlay URL** from `setup.html`.
6. In OBS: **Tools → Scripts**, click **+** and choose `counter-hotkeys.lua` from the Live Counter folder. Then assign keys in **Settings → Hotkeys** (see Hotkeys below).

The dock's Diagnostics tab shows a checklist for each part and names the fix for anything that is not green.

## Hotkeys

Hotkeys are set up in two places:

1. **Install the script once**: OBS → **Tools → Scripts** → **+** → choose `counter-hotkeys.lua` from the Live Counter folder.
2. **Assign keys**: OBS → **Settings → Hotkeys** → scroll to the five entries starting with "Live Counter:", click into each field and press the keys you want.

Keyboard shortcuts need the OBS connection from step 4 (the password step). Without it, key presses do nothing.

Include a modifier key in every shortcut. A bare key such as `+` or `-` can fire while you type in another text field in OBS. Suggested combinations:

| Action | Windows | Mac |
| --- | --- | --- |
| +1 | Ctrl + Alt + = | Ctrl + Option + = |
| −1 | Ctrl + Alt + − | Ctrl + Option + − |
| Undo | Ctrl + Alt + Z | Ctrl + Option + Z |
| Pause / Resume | Ctrl + Alt + P | Ctrl + Option + P |
| Show / Hide overlay | Ctrl + Alt + H | Ctrl + Option + H |

On a Mac, avoid Cmd + H (it hides OBS) and Cmd + Z (OBS's own Undo). You don't have to use these combinations: any modifier combination that OBS isn't already using works. Each hotkey is optional, so bind only the ones you plan to use.

Once assigned, these work like any other OBS hotkey, including through a Stream Deck's OBS integration.

The script, its key assignments and the overlay source are saved in the OBS scene collection you set them up in. If you switch to another scene collection (the **Scene Collection** menu), add the overlay and `counter-hotkeys.lua` there too and assign the keys again.

## Daily use

1. Load or start a preset in the **Presets** tab, or set up a one-off count in **Setup**, then click **Start session**.
2. Click **Show** to put the number on the overlay, then bring the scene to Program in OBS as usual.
3. Count with **+1 / −1 / Undo / Jump to**. At either end of the range the count stops. Nothing breaks.
4. In Automatic mode, use **Pause / Resume / Faster / Slower / Reverse**.
5. When you're done, **Hide** the overlay or **End** the session.

## If something breaks

- **The dock looks stuck or frozen:** reload it (right-click the dock → Reload, or close and reopen it from Docks). It reads the current count back from storage and carries on. Nothing is lost.
- **OBS crashes or you have to restart it:** when OBS reopens, the dock restores your last session, paused, so you can check the number before continuing. Nothing is lost.
- **OBS asks "Are you sure you want to exit?" when quitting:** that is OBS's own exit confirmation, not a Live Counter warning. Your session is already saved, so it is safe to confirm.
- **Something looks wrong (wrong numbers, stuck settings):** open the dock's **Diagnostics** tab and use **Reset everything**. It asks you to confirm and names what it deletes (settings, presets, sessions and logs on this computer). It cannot be undone, so use it only as a last resort.
- **Still stuck:** click **Copy diagnostics** on the Diagnostics tab and send the result to whoever is helping you.

## If you move or rename the folder

OBS remembers the folder's exact location. After a move or rename, the dock shows a "File not found" page, the overlay goes blank and the hotkeys stop. To fix it:

1. Double-click `setup.html` in the folder's new location.
2. In OBS: **Docks → Custom Browser Docks**. Replace the Live Counter URL with the new **Dock URL** and click Apply.
3. Point the overlay at the new address. With the overlay's scene in Program, open the dock's **Diagnostics** tab and click **Fix overlay settings**. Or right-click the overlay in Sources, choose **Properties** and paste the new **Overlay URL**.
4. In OBS: **Tools → Scripts**. Remove `counter-hotkeys.lua` with **−**, then add it again from the new folder with **+**. Check **Settings → Hotkeys** and reassign any keys that are missing.

To be safe, Export your presets from the **Presets** tab before you move the folder.

## Moving to another computer

Copy the Live Counter folder to a permanent place on the new computer and repeat **One-time setup** above. The dock and overlay addresses are different on every computer, and `setup.html` always shows the right ones for wherever it is opened.

Presets do not come along with the folder. On the old computer, click **Export** in the **Presets** tab and paste the result into a text file you can carry across. On the new computer, copy that text, then use **Import** in the Presets tab to bring the presets in.
