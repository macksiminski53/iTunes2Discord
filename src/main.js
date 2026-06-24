// src/main.js
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- Single-instance lock ----
// This MUST run before anything else touches the app/Tray/etc. Electron's
// own docs warn that requesting the lock late (e.g. after app.on('ready')
// is already registered) can race with a second instance briefly starting
// up before it's told to quit. Doing it first, before any other Electron
// API is used, avoids that.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Tray-only app, nothing to focus — just let the existing instance
    // keep running and let this second launch exit quietly.
  });

  runApp();
}

function runApp() {
  const DiscordRPC = require('@xhayper/discord-rpc');
  const { autoUpdater } = require('electron-updater');
  const log = require('electron-log');

  // ---- CONFIG ----
  // This is the app's Discord Application/Client ID (created once by the developer
  // at https://discord.com/developers/applications). End users do NOT need their
  // own ID -- everyone using iTunes2Discord shares this one, same as how every
  // Spotify user shares Spotify's single Discord integration.
  const CLIENT_ID = '1518362803008831769';

  const POLL_INTERVAL_MS = 15000; // how often to check iTunes/Music (15s is safe re: rate limits)
  const APP_NAME = 'iTunes2Discord';

  let tray = null;
  let mainWindow = null;
  let rpc = null;
  let connected = false;
  let lastTrackKey = null;
  let lastPosition = null;
  let lastTrackState = null; // cached for the window's initial state request
  let pollTimer = null;
  let enabled = true;
  let warnedUnsupportedPlatform = false;

  // ---- Logging (writes to %APPDATA%/itunes2discord/logs on Windows,
  // ~/Library/Logs/itunes2discord on macOS) ----
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  autoUpdater.logger = log;

  // ---- Track polling (Windows: PowerShell/COM against iTunes. macOS: AppleScript against Music/iTunes) ----
  function getScriptPath(filename) {
    const normalPath = path.join(__dirname, filename);
    // When packaged, asarUnpack extracts this file to a parallel
    // "app.asar.unpacked" folder since external processes (PowerShell,
    // osascript) cannot read files that live inside the compressed .asar
    // archive itself.
    if (app.isPackaged) {
      return normalPath.replace('app.asar', 'app.asar.unpacked');
    }
    return normalPath;
  }

  function getCurrentTrackWindowsCOM() {
    return new Promise((resolve) => {
      const scriptPath = getScriptPath('get-track.ps1');
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ]);

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (d) => (stdout += d.toString()));
      ps.stderr.on('data', (d) => (stderr += d.toString()));

      ps.on('close', () => {
        if (stderr) log.warn('PowerShell stderr:', stderr.trim());
        try {
          const trimmed = stdout.trim();
          if (!trimmed) return resolve({ state: 'not_running' });
          resolve(JSON.parse(trimmed));
        } catch (e) {
          log.warn('Failed to parse PowerShell output:', stdout);
          resolve({ state: 'not_running' });
        }
      });

      ps.on('error', (err) => {
        log.error('Failed to spawn PowerShell:', err.message);
        resolve({ state: 'not_running' });
      });
    });
  }

  function getCurrentTrackSMTC() {
    return new Promise((resolve) => {
      const scriptPath = getScriptPath('get-track-smtc.ps1');
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ]);

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (d) => (stdout += d.toString()));
      ps.stderr.on('data', (d) => (stderr += d.toString()));

      ps.on('close', () => {
        if (stderr) log.warn('SMTC PowerShell stderr:', stderr.trim());
        try {
          const trimmed = stdout.trim();
          if (!trimmed) return resolve({ state: 'not_running' });
          resolve(JSON.parse(trimmed));
        } catch (e) {
          log.warn('Failed to parse SMTC PowerShell output:', stdout);
          resolve({ state: 'not_running' });
        }
      });

      ps.on('error', (err) => {
        log.error('Failed to spawn SMTC PowerShell:', err.message);
        resolve({ state: 'not_running' });
      });
    });
  }

  async function getCurrentTrackWindows() {
    // Try classic iTunes (COM) first since it's the most full-featured
    // source (gives us album artwork, which SMTC currently doesn't).
    const fromItunes = await getCurrentTrackWindowsCOM();
    if (fromItunes.state !== 'not_running') {
      return fromItunes;
    }
    // iTunes isn't running or has nothing playing -- fall back to SMTC,
    // which covers the Apple Music app for Windows (and other SMTC-aware
    // apps) since Apple Music has no public automation API of its own.
    return getCurrentTrackSMTC();
  }

  function getCurrentTrack() {
    if (process.platform === 'win32') return getCurrentTrackWindows();
    if (!warnedUnsupportedPlatform) {
      log.warn(`${APP_NAME} only supports Windows currently.`);
      warnedUnsupportedPlatform = true;
    }
    return Promise.resolve({ state: 'not_running' });
  }

  // ---- Discord RPC ----
  async function connectDiscord() {
    if (connected) return;
    rpc = new DiscordRPC.Client({
      clientId: CLIENT_ID,
      transport: { type: 'ipc' },
    });

    rpc.on('ready', () => {
      connected = true;
      log.info('Connected to Discord RPC');
      updateTrayMenu();
      pushStateUpdate();
    });

    rpc.on('disconnected', () => {
      connected = false;
      log.info('Disconnected from Discord RPC');
      updateTrayMenu();
      pushStateUpdate();
      setTimeout(connectDiscord, 10000);
    });

    try {
      await rpc.login();
    } catch (err) {
      log.warn('Discord login failed (is Discord running?):', err.message);
      connected = false;
      setTimeout(connectDiscord, 10000);
    }
  }

  // ---- Album artwork upload (Imgur) ----
  // Discord Rich Presence images must be either pre-uploaded asset keys or a
  // public https:// URL it can fetch -- it can't read files off the user's
  // disk. So for real per-song album art, we upload each track's artwork to
  // Imgur anonymously (no account needed) and use the resulting URL.
  const artworkUrlCache = new Map();

  function uploadArtworkToImgur(filePath) {
    return new Promise((resolve) => {
      let imageData;
      try {
        imageData = fs.readFileSync(filePath, { encoding: 'base64' });
      } catch (e) {
        log.warn('Could not read artwork file:', e.message);
        return resolve(null);
      }

      // Hash the actual image bytes for the cache key -- the artwork file on
      // disk gets overwritten in place for every new track, so caching by
      // file PATH would incorrectly reuse a stale URL from a previous song.
      const contentHash = crypto.createHash('md5').update(imageData).digest('hex');
      if (artworkUrlCache.has(contentHash)) {
        return resolve(artworkUrlCache.get(contentHash));
      }

      const postData = `image=${encodeURIComponent(imageData)}&type=base64`;

      const req = https.request(
        {
          hostname: 'api.imgur.com',
          path: '/3/image',
          method: 'POST',
          headers: {
            // Imgur's public anonymous-upload Client ID -- meant to be
            // embedded in client apps, not a secret.
            Authorization: 'Client-ID 546c25a59c58ad7',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 10000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.success && json.data && json.data.link) {
                const url = json.data.link;
                artworkUrlCache.set(contentHash, url);
                // Keep the cache from growing forever across a long session.
                if (artworkUrlCache.size > 50) {
                  const firstKey = artworkUrlCache.keys().next().value;
                  artworkUrlCache.delete(firstKey);
                }
                resolve(url);
              } else {
                log.warn('Imgur upload did not return a link:', body.slice(0, 200));
                resolve(null);
              }
            } catch (e) {
              log.warn('Failed to parse Imgur response:', e.message);
              resolve(null);
            }
          });
        }
      );

      req.on('error', (e) => {
        log.warn('Imgur upload request failed:', e.message);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        log.warn('Imgur upload timed out');
        resolve(null);
      });

      req.write(postData);
      req.end();
    });
  }

  async function setPresence(track) {
    if (!connected || !rpc?.user) {
      log.warn('Skipped presence update — not connected to Discord yet');
      return false;
    }

    if (track.state !== 'playing' && track.state !== 'paused') {
      await rpc.user.clearActivity().catch(() => {});
      return true;
    }

    const now = Date.now();
    const startTimestamp = Math.floor(now - track.position * 1000);
    const endTimestamp = Math.floor(now + (track.duration - track.position) * 1000);

    // Try to use the real album art (uploaded to Imgur so Discord can fetch
    // it); fall back to the app's static logo if there's no artwork or the
    // upload fails for any reason.
    let largeImage = 'itunes_logo';
    if (track.artworkPath) {
      const uploadedUrl = await uploadArtworkToImgur(track.artworkPath);
      if (uploadedUrl) {
        largeImage = uploadedUrl;
      }
    }

    const activity = {
      details: track.name || 'Unknown track',
      state: track.artist ? `by ${track.artist}` : 'Unknown artist',
      largeImageKey: largeImage,
      largeImageText: track.album || '',
      instance: false,
    };

    if (track.state === 'playing') {
      activity.startTimestamp = startTimestamp;
      activity.endTimestamp = endTimestamp;
      activity.smallImageKey = 'play_icon';
      activity.smallImageText = 'Playing';
    } else {
      activity.smallImageKey = 'pause_icon';
      activity.smallImageText = 'Paused';
    }

    try {
      await rpc.user.setActivity(activity);
      return true;
    } catch (e) {
      log.warn('setActivity failed:', e.message);
      return false;
    }
  }

  // ---- Polling loop ----
  let firstPollDone = false;

  async function pollLoop() {
    if (!enabled) {
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
      return;
    }

    try {
      const track = await getCurrentTrack();

      if (track.state === 'not_running' || track.state === 'stopped') {
        // Always update on the very first poll, even with no change, so the
        // tooltip never stays stuck on "starting..." forever.
        if (lastTrackKey !== null || !firstPollDone) {
          lastTrackKey = null;
          lastPosition = null;
          if (connected && rpc?.user) await rpc.user.clearActivity().catch(() => {});
          updateTrayTooltip(`${APP_NAME} — nothing playing`);
        }
        pushStateUpdate(track);
      } else {
        const key = `${track.name}|${track.artist}|${track.state}`;

        // Same song/state as last poll, but the position jumped backwards
        // (repeat-one looped, or the user scrubbed back) — without this,
        // the dedupe key never changes so Discord's elapsed-time bar would
        // silently go stale instead of restarting.
        const positionRewound =
          key === lastTrackKey &&
          lastPosition !== null &&
          track.position < lastPosition - 3;

        if (key !== lastTrackKey || positionRewound || !firstPollDone) {
          const pushedOk = await setPresence(track);
          if (pushedOk) {
            lastTrackKey = key;
          }
          updateTrayTooltip(`${track.state === 'playing' ? '▶' : '⏸'} ${track.name} — ${track.artist}`);
          log.info('Now:', track.state, track.name, '-', track.artist);
        }
        lastPosition = track.position;
        pushStateUpdate(track);
      }
    } catch (err) {
      log.error('pollLoop error:', err.message);
      updateTrayTooltip(`${APP_NAME} — error, retrying...`);
    } finally {
      firstPollDone = true;
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
    }
  }

  // ---- Main window ----
  function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 360,
      height: 560,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#0F0F14',
      title: APP_NAME,
      frame: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });

    // Spec: closing the window just hides it, app keeps running in tray.
    mainWindow.on('close', (e) => {
      e.preventDefault();
      mainWindow.hide();
    });

    // If the window is ever actually destroyed (not just hidden) — e.g. by
    // Electron during shutdown — drop our reference so createWindow() knows
    // to build a fresh one next time, instead of calling methods on a dead
    // object and throwing "Object has been destroyed".
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  function artworkToDataUrl(artworkPath) {
    if (!artworkPath) return null;
    try {
      const data = fs.readFileSync(artworkPath);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch (e) {
      return null;
    }
  }

  function pushStateUpdate(track) {
    if (track) {
      lastTrackState = {
        ...track,
        artworkDataUrl: artworkToDataUrl(track.artworkPath),
      };
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('state-update', {
      connected,
      syncEnabled: enabled,
      version: app.getVersion(),
      track: lastTrackState,
    });
  }

  ipcMain.handle('get-state', () => ({
    connected,
    syncEnabled: enabled,
    version: app.getVersion(),
    track: lastTrackState,
  }));

  ipcMain.on('toggle-pause', () => {
    enabled = !enabled;
    if (!enabled && connected && rpc?.user) {
      rpc.user.clearActivity().catch(() => {});
    } else if (enabled) {
      // Force the next poll to actually push to Discord even if the same
      // song is still playing — otherwise the dedupe check in pollLoop
      // thinks nothing changed and silently skips re-sending the status.
      lastTrackKey = null;
    }
    updateTrayMenu();
    pushStateUpdate();
  });

  ipcMain.on('check-for-updates', () => {
    autoUpdater.checkForUpdates();
  });

  ipcMain.on('quit-app', () => {
    if (connected && rpc?.user) rpc.user.clearActivity().catch(() => {});
    app.quit();
  });

  // ---- Tray UI ----
  function updateTrayTooltip(text) {
    if (tray) tray.setToolTip(text);
  }

  function updateTrayMenu() {
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate([
      { label: `${APP_NAME} v${app.getVersion()}`, enabled: false },
      {
        label: connected ? '✅ Connected to Discord' : '❌ Not connected to Discord',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Show window',
        click: () => createWindow(),
      },
      {
        label: enabled ? 'Pause syncing' : 'Resume syncing',
        click: () => {
          enabled = !enabled;
          if (!enabled && connected && rpc?.user) {
            rpc.user.clearActivity().catch(() => {});
          } else if (enabled) {
            // Force the next poll to actually push to Discord even if the
            // same song is still playing — see matching comment in the
            // 'toggle-pause' IPC handler above for why this is needed.
            lastTrackKey = null;
          }
          updateTrayMenu();
          pushStateUpdate();
        },
      },
      {
        label: 'Check for updates',
        click: () => autoUpdater.checkForUpdates(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          if (connected && rpc?.user) rpc.user.clearActivity().catch(() => {});
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }

  // ---- Auto-update events ----
  autoUpdater.on('update-available', () => {
    log.info('Update available, downloading...');
  });

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: `${APP_NAME} update ready`,
        message: 'A new version has been downloaded. Restart now to install it?',
        buttons: ['Restart now', 'Later'],
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('error', (err) => {
    log.warn('Auto-update error:', err.message);
  });

  // ---- App lifecycle ----
  app.whenReady().then(() => {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip(`${APP_NAME} — starting...`);
    updateTrayMenu();

    // Spec: single click opens the window (right-click still shows the
    // context menu via setContextMenu, which Electron handles separately
    // from this click event on Windows/Linux).
    tray.on('click', () => createWindow());

    connectDiscord();
    pollLoop();

    // Check for updates ~5s after launch, then silently every few hours.
    // Using checkForUpdates() (not checkForUpdatesAndNotify) since we have
    // our own custom dialog for update-downloaded, and the "AndNotify"
    // variant can trigger an unwanted blank window on some platforms/builds.
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', (e) => {
    e?.preventDefault?.();
  });
}
