# Checkpoint ✅

A local-first productivity checklist: recurring daily / weekly / monthly tasks
plus a backlog of TV shows, movies, and games you want to get around to.

No install, no server, no account — plain HTML/CSS/JS with all data stored in
your browser via IndexedDB.

## Run it

Just double-click `index.html` (or right-click → Open with → your browser).

Bookmark it or pin the tab — data persists between sessions in the browser
you opened it with.

## How the task reset works

Tasks are never wiped by a timer. Each task records which *periods* it was
completed in (a date for daily tasks, a week-of-Monday for weekly, a month for
monthly). A task shows as checked only for the **current** period, so when the
day/week/month rolls over it automatically shows up unchecked again — and your
completion history (and 🔥 streaks) are preserved.

- Weeks start on **Monday**
- Streak badges appear at 2+ consecutive periods
- Tasks added as **📌 One-time** never reset — once checked off they stay
  done (delete them when you no longer want them on the board)

## Backlog

Add shows/movies/games, filter by type or status, and click the status pill to
cycle: Backlog → In progress → Done.

## Widget mode

Ways to run Checkpoint as a small desktop widget:

- **Double-click `Checkpoint Widget.lnk`** (recommended) — opens a
  chromeless, compact window docked in the top-right corner. Works even on
  IT-managed machines where script files are blocked, since it launches Edge
  directly. Copy or pin the shortcut wherever you like (Desktop, taskbar).
- **Settings → Widget mode → Open widget** — opens the same compact view as
  a small popup window from within the app.
- **`widget.cmd` / `widget.ps1`** — launcher scripts for unmanaged machines;
  the .ps1 additionally pins the window **always-on-top**. Note: on machines
  with AppLocker/ConstrainedLanguage policies these are blocked — use the
  .lnk instead, and PowerToys "Always On Top" (Win+Ctrl+T) for pinning.

The widget uses the same local database as the full app, so both stay in
sync (changes appear when the other window regains focus).

## Using it in more than one browser

Browser storage is separate per browser, so by default Edge and Chrome each
see their own data. Two remedies, both in ⚙️ Settings:

- **Sync file** — click "Create new" the first time and save a
  `checkpoint-data.json` somewhere (e.g. Documents, or OneDrive to sync
  across machines too). Every change is written to that file, and it's
  re-read on startup, window focus, and a background check every couple of
  seconds. In your other browser, use "Connect existing" and pick the
  **same file** — you'll be asked whether to load its data. Browsers
  require a one-click permission re-grant per session (a "Reconnect"
  banner appears; clicking anywhere in the app also triggers the prompt).
- **Backup Export / Import** — manual JSON export/import, works in any
  browser including Firefox.

## Hosting it on a server (recommended for multi-device)

Copy this folder to any machine with Node.js 18+ and run:

    node server.js

Then open `http://<server-address>:8787` from any device — phone, laptop,
work PC. The server stores the shared data in `checkpoint-data.json` next
to `server.js`; every device pushes changes to it and polls it for updates,
so no sync file or OneDrive is needed. The app detects server mode
automatically (Settings shows "Server sync: Synced with this server").

Options (environment variables):

- `PORT=9000 node server.js` — change the port (default 8787)
- `CHECKPOINT_TOKEN=mysecret node server.js` — require a passcode; each
  device prompts for it once (banner → Reconnect) and remembers it

### Linux quickstart (e.g. Linux Mint / Cinnamon)

Mint's default `apt` Node.js is often too old — install a current one, then
clone and run:

    # Node 22 LTS via NodeSource (once)
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    node --version   # should be 18+

    git clone https://github.com/Itsjonzer/Checkpoint.git
    cd Checkpoint
    node server.js   # test: open http://<server-ip>:8787 from another device

If the firewall is on: `sudo ufw allow 8787/tcp`.

To keep it running across reboots, create a systemd service —
`sudo nano /etc/systemd/system/checkpoint.service`:

    [Unit]
    Description=Checkpoint productivity app
    After=network.target

    [Service]
    ExecStart=/usr/bin/node /home/YOURUSER/Checkpoint/server.js
    WorkingDirectory=/home/YOURUSER/Checkpoint
    Restart=always
    User=YOURUSER
    # Environment=CHECKPOINT_TOKEN=yourpasscode
    # Environment=PORT=8787

    [Install]
    WantedBy=multi-user.target

Then: `sudo systemctl enable --now checkpoint` (status via
`systemctl status checkpoint`). Data lives in `checkpoint-data.json` inside
the repo folder — back it up like any file, or use the app's Export button.

Extras:

- **Keep it running:** on Linux use the systemd service above (or `pm2`); on
  Windows, Task Scheduler → run `node C:\path\to\Checkpoint\server.js` at
  startup.
- **Install like an app:** served over HTTPS (or localhost), browsers offer
  an install prompt (PWA) — it gets its own window and icon, and the app
  shell works offline, syncing when the server is reachable again.
- **Widget against the server:** edit the widget shortcut's target URL to
  `http://<server-address>:8787/?widget=1`.
- **Offline devices:** changes save locally and push automatically when the
  server is reachable again; if two devices edit at once, last writer wins.
- If two people would use it, run two copies of the folder on different
  ports — the app is single-user by design.

## Syncing across devices with OneDrive (no server needed)

Alternative to hosting: keep the folder in OneDrive. On another computer
(signed into the same OneDrive):

1. Let OneDrive sync, then open `index.html` from the Checkpoint folder
   (right-click → Open with → Edge/Chrome).
2. Go to ⚙️ Settings → Sync file → **Connect existing** and pick the
   `checkpoint-data.json` sitting in the same folder.
3. Optional: make a widget shortcut — right-click the desktop → New →
   Shortcut, and use the target from "Checkpoint Widget.lnk" (adjusting
   the folder path for that machine).

Notes: each device keeps a fast local copy and reads/writes the shared
file; if two devices edit while one is offline, last writer wins (OneDrive
may occasionally create a conflict copy of the JSON — keep the newest).

## Notes / future upgrades

- **Data location:** data lives in the browser profile that opened the file.
  Clearing site data for the page will erase it.
- **Want a real .exe?** The whole app is a static web page, so it can be
  wrapped with [Tauri](https://tauri.app) (tiny output) or Electron later with
  no code changes.
- **Want it on your phone?** Host the folder anywhere static (GitHub Pages,
  Netlify) and add a PWA manifest + service worker to make it installable.
