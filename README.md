# MusicToDiscord

Shows what you're playing in iTunes or Apple Music as your Discord status —
e.g. **"Listening to MusicToDiscord — Blinding Lights by The Weeknd"** with
a live countdown timer.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## Install (for users)

### Windows

1. Go to the [Releases page](../../releases) and download the latest
   `MusicToDiscord-Setup-x.x.x.exe`.
2. Run it. Windows may show a "Windows protected your PC" SmartScreen warning
   since this isn't a paid-signed app yet — click **More info → Run anyway**.
3. Once installed, a small music-note icon appears in your system tray, and
   the app's status window opens automatically.
4. Make sure the **Discord desktop app** (not browser) is open and you're
   logged in.
5. Play something in iTunes or Apple Music — your Discord status updates
   within ~15 seconds.

The app auto-updates itself in the background and auto-checks for new
versions on startup. Click the tray icon any time to reopen the window,
pause syncing, check for updates, or quit. Double-clicking the Desktop or
Start Menu shortcut while it's already running will bring the window back
to front instead of doing nothing.

**Requirements:**
- Windows 10/11
- Either classic iTunes or the Apple Music app installed
- Discord desktop app (not the browser version)

### macOS

1. Go to the [Releases page](../../releases) and download the latest
   `MusicToDiscord-x.x.x.dmg`.
2. Open the `.dmg` and drag **MusicToDiscord** into your Applications folder.
3. **First launch only — Gatekeeper warning:** macOS will say the app is
   "damaged" or can't be opened because it isn't from an identified developer.
   This is expected for unsigned apps. To get past it, either:
   - **Right-click** (or Control-click) the app → click **Open** → click
     **Open** again on the popup, or
   - Open Terminal and run:
     ```
     xattr -cr /Applications/MusicToDiscord.app
     ```
     Then double-click the app normally.
4. The first time it queries Music, macOS will ask for permission to control
   the Music app — click **OK**. This is required for the app to see what's
   playing.
5. Make sure the **Discord desktop app** (not browser) is open and you're
   logged in.
6. Play something in Music — your Discord status updates within ~15 seconds.

**Requirements:**
- macOS 10.15 Catalina or later
- Apple Music (or legacy iTunes on older macOS)
- Discord desktop app (not the browser version)

---

## How it works

- On **Windows**, a bundled PowerShell script first queries iTunes' built-in
  COM automation interface for the current track. If iTunes isn't running, it
  falls back to a second script that reads Windows' System Media Transport
  Controls (SMTC) instead — this covers the Apple Music app, since it has no
  automation interface of its own. Neither script ever launches an app that
  isn't already open.
- On **macOS**, a bundled AppleScript queries the Music app directly. It
  checks the process list first and does nothing if Music isn't already open.
- The app polls every few seconds and forwards the track info to Discord via
  Discord's local Rich Presence (RPC) connection — the same mechanism Spotify
  and games use.
- Between polls, the app's own window keeps a local one-second clock running
  so the countdown timer flows smoothly instead of jumping. It freezes the
  instant playback is paused and picks back up exactly where it left off.
- Album art is uploaded anonymously to Imgur (no account needed) so Discord
  can display it — nothing else about your music or activity is uploaded
  anywhere.

---

## For developers / contributors

```
git clone https://github.com/MackSiminski53/itunes2discord.git
cd itunes2discord
npm install
npm start
```

### Releasing a new version (maintainer only)

GitHub Actions auto-builds and publishes both the Windows and macOS installers:

1. Bump the version in `package.json` (e.g. `1.6.0`).
2. Commit, then tag and push:
   ```
   git add .
   git commit -m "Bump to 1.6.0"
   git tag v1.6.0
   git push origin main --tags
   ```
3. GitHub Actions spins up a `windows-latest` runner for the `.exe` and a
   `macos-latest` runner for the `.dmg`, builds both installers, and publishes
   them to the Releases page automatically. Existing installs will offer the
   update to users via `electron-updater` within a few hours.

No `GH_TOKEN` setup needed — GitHub Actions provides one automatically with
the right permissions for the same repo.

---

## Troubleshooting

- **SmartScreen blocks the installer (Windows)** — expected for unsigned apps;
  click "More info → Run anyway."
- **"Damaged" warning on macOS** — see the macOS install steps above; run
  `xattr -cr /Applications/MusicToDiscord.app` in Terminal to fix it.
- **Music permission denied on macOS** — go to **System Settings → Privacy &
  Security → Automation** and make sure MusicToDiscord has permission to
  control Music.
- **Tray says "Not connected to Discord"** — open the Discord desktop app
  and log in.
- **Status never updates** — make sure either iTunes or Apple Music is
  actually open and playing; right-click the tray icon to see what it
  currently detects.
- **Discord shows nothing at all, even though the app says connected** — go
  to Discord's **Settings → Activity Privacy** and make sure "Display current
  activity as a status message" is turned on.
- **Status disappears when paused/stopped** — expected behavior.

---

## Contributing

Issues and pull requests welcome. This is a small personal-use utility, not
an official Apple/Discord product — see
[Discord's Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy)
for the rules this kind of integration follows.

## License

[MIT](LICENSE)
