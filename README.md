# iTunes2Discord

Shows what you're playing in iTunes as your Discord status — e.g. **"Listening to iTunes — Blinding Lights by The Weeknd"** with a live progress bar.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## Install (for users)

1. Go to the [Releases page](../../releases) and download the latest `iTunes2Discord-Setup-x.x.x.exe`.
2. Run it. Windows may show a "Windows protected your PC" SmartScreen warning since this isn't a paid-signed app yet — click **More info → Run anyway**.
3. Once installed, a small music-note icon appears in your system tray.
4. Make sure the **Discord desktop app** (not browser) is open and you're logged in.
5. Play something in iTunes — your Discord status updates within ~15 seconds.

The app auto-updates itself in the background, and auto-checks for new versions on startup. Right-click the tray icon any time to pause syncing, check for updates, or quit.

### Requirements
- Windows 10/11
- Classic iTunes app installed (not the Apple Music Windows preview app — it doesn't expose the same automation interface)
- Discord desktop app

---

## How it works

- A bundled PowerShell script queries iTunes' built-in COM automation interface for the current track, artist, album, and playback position.
- The app polls this every 15 seconds and forwards it to Discord via Discord's local Rich Presence (RPC) connection — the same mechanism Spotify and games use.
- Nothing is uploaded anywhere; everything stays on your machine and goes only to your own Discord client.

---

## For developers / contributors

```
git clone https://github.com/MackSiminski53/itunes2discord.git
cd itunes2discord
npm install
npm start
```

### Releasing a new version (maintainer only)

This repo uses GitHub Actions to auto-build and publish installers:

1. Bump the version in `package.json` (e.g. `1.0.1`).
2. Commit, then tag and push:
   ```
   git add .
   git commit -m "Bump to 1.0.1"
   git tag v1.0.1
   git push origin main --tags
   ```
3. GitHub Actions builds the Windows installer and publishes it to the Releases page automatically. Existing installs will offer the update to users via `electron-updater` within a few hours.

No `GH_TOKEN` setup needed — GitHub Actions provides one automatically with the right permissions for the same repo.

---

## Troubleshooting

- **SmartScreen blocks the installer** — expected for unsigned apps; click "More info → Run anyway." A future release may add code signing.
- **Tray says "Not connected to Discord"** — open the Discord desktop app and log in.
- **Status never updates** — confirm you're using classic iTunes, not the Apple Music preview app; right-click the tray icon to see what it currently detects.
- **Status disappears when paused/stopped** — expected behavior.

## Contributing

Issues and pull requests welcome. This is a small personal-use utility, not an official Apple/Discord product — see [Discord's Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) for the rules this kind of integration follows.

## License

[MIT](LICENSE)
