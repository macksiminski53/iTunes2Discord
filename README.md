# iTunes2Discord

Shows what you're playing in iTunes (Windows) or Music (macOS) as your Discord status — e.g. **"Listening to iTunes — Blinding Lights by The Weeknd"** with a live progress bar.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## Install (for users)

### Windows

1. Go to the [Releases page](../../releases) and download the latest `iTunes2Discord-Setup-x.x.x.exe`.
2. Run it. Windows may show a "Windows protected your PC" SmartScreen warning since this isn't a paid-signed app yet — click **More info → Run anyway**.
3. Once installed, a small music-note icon appears in your system tray.
4. Make sure the **Discord desktop app** (not browser) is open and you're logged in.
5. Play something in iTunes — your Discord status updates within ~15 seconds.

### macOS

1. Go to the [Releases page](../../releases) and download the latest `iTunes2Discord-x.x.x.dmg`.
2. Open the dmg and drag iTunes2Discord into Applications.
3. Launch it. Since this isn't a notarized app yet, macOS Gatekeeper will refuse to open it the normal way — **right-click (or Control-click) the app → Open → Open** instead of double-clicking. You only need to do this once.
4. A small music-note icon appears in your menu bar (top right). The app has no Dock icon by design.
5. The first time it checks what's playing, macOS will ask **"iTunes2Discord wants access to control Music"** — click **OK**. If you accidentally click "Don't Allow," you can re-enable it under **System Settings → Privacy & Security → Automation → iTunes2Discord → Music**.
6. Make sure the **Discord desktop app** (not browser) is open and you're logged in.
7. Play something in Music — your Discord status updates within ~15 seconds.

Both platforms: the app auto-updates itself in the background, and auto-checks for new versions on startup. Click the tray/menu-bar icon any time to pause syncing, check for updates, or quit.

### Requirements
- **Windows:** Windows 10/11, classic iTunes app installed (not the Apple Music Windows preview app — it doesn't expose the same automation interface), Discord desktop app.
- **macOS:** macOS 10.15 (Catalina) or later with the built-in Music app (older systems with classic iTunes are also supported), Discord desktop app.

---

## How it works

- **Windows:** a bundled PowerShell script queries iTunes' built-in COM automation interface for the current track, artist, album, and playback position. It only does this if iTunes is already running — it never launches iTunes on its own.
- **macOS:** a bundled AppleScript queries Music's (or legacy iTunes') scripting interface the same way. It checks the process list first so it never launches Music in the background either.
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

`npm start` runs the app locally on whatever OS you're developing on — the code automatically picks the right track-polling method (PowerShell on Windows, AppleScript on macOS).

### Releasing a new version (maintainer only)

This repo uses GitHub Actions to auto-build and publish installers for **both** platforms:

1. Bump the version in `package.json` (e.g. `1.2.1`).
2. Commit, then tag and push:
   ```
   git add .
   git commit -m "Bump to 1.2.1"
   git tag v1.2.1
   git push origin main --tags
   ```
3. GitHub Actions spins up a `windows-latest` and a `macos-latest` runner, builds both installers, and publishes them to the Releases page automatically. Existing installs will offer the update to users via `electron-updater` within a few hours.

No `GH_TOKEN` setup needed — GitHub Actions provides one automatically with the right permissions for the same repo.

**Note on macOS builds:** without an Apple Developer ID certificate configured (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets), the macOS build is unsigned and un-notarized. It still builds and works fine, but users see the Gatekeeper "right-click → Open" step above. If you get a paid Apple Developer account later, add those secrets and electron-builder will sign the build, and it can also be notarized for a smoother install.

---

## Troubleshooting

### Windows
- **SmartScreen blocks the installer** — expected for unsigned apps; click "More info → Run anyway." A future release may add code signing.
- **Tray says "Not connected to Discord"** — open the Discord desktop app and log in.
- **Status never updates** — confirm you're using classic iTunes, not the Apple Music preview app; right-click the tray icon to see what it currently detects.

### macOS
- **"App is damaged and can't be opened" / Gatekeeper blocks it** — right-click the app → Open → Open (only needed the first time).
- **Status never updates / "Not authorized" in the logs** — go to **System Settings → Privacy & Security → Automation** and make sure iTunes2Discord has permission to control Music. If it's missing from the list, quit the app, remove it under Automation, relaunch, and approve the prompt when it appears.
- **Menu-bar icon says "Not connected to Discord"** — open the Discord desktop app and log in.

### Both platforms
- **Status disappears when paused/stopped** — expected behavior.

## Contributing

Issues and pull requests welcome. This is a small personal-use utility, not an official Apple/Discord product — see [Discord's Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) for the rules this kind of integration follows.

## License

[MIT](LICENSE)
