// src/main.js
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---- Single-instance lock ----
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // If user tries to open a second instance, focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  runApp();
}

let mainWindow = null;

function runApp() {
  const DiscordRPC = require('@xhayper/discord-rpc');
  const { autoUpdater } = require('electron-updater');
  const log = require('electron-log');

  // ---- CONFIG ----
  const CLIENT_ID = '1518362803008831769';
  const POLL_INTERVAL_MS = 15000;
  const APP_NAME = 'iTunes2Discord';

  let tray = null;
  let rpc = null;
  let connected = false;
  let lastTrackKey = null;
  let lastPosition = null;
  let pollTimer = null;
  let enabled = true;
  let warnedUnsupportedPlatform = false;
  let currentTrackState = null; // latest track info for the renderer

  // ---- Logging ----
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  autoUpdater.logger = log;

  // ---- Data Persistence ----
  // Stores play history and per-song play counts in a JSON file at:
  //   Windows: %APPDATA%/itunes2discord/play-data.json
  //   macOS:   ~/Library/Application Support/itunes2discord/play-data.json
  const dataDir = app.getPath('userData');
  const dataFile = path.join(dataDir, 'play-data.json');

  function loadData() {
    try {
      if (fs.existsSync(dataFile)) {
        const raw = fs.readFileSync(dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        // Basic structure validation
        return {
          history: Array.isArray(parsed.history) ? parsed.history : [],
          playCounts: (parsed.playCounts && typeof parsed.playCounts === 'object') ? parsed.playCounts : {},
        };
      }
    } catch (err) {
      log.warn('Failed to load play data, starting fresh:', err.message);
    }
    return { history: [], playCounts: {} };
  }

  function saveData(data) {
    try {
      // Keep history to a reasonable size (last 5000 entries)
      if (data.history.length > 5000) {
        data.history = data.history.slice(-5000);
      }
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      log.warn('Failed to save play data:', err.message);
    }
  }

  let playData = loadData();

  function recordPlay(track) {
    const entry = {
      name: track.name,
      artist: track.artist,
      album: track.album || '',
      timestamp: Date.now(),
    };

    playData.history.push(entry);

    // Update play count
    const key = `${track.name}||${track.artist}`;
    if (!playData.playCounts[key]) {
      playData.playCounts[key] = {
        name: track.name,
        artist: track.artist,
        album: track.album || '',
        count: 0,
        lastPlayed: 0,
      };
    }
    playData.playCounts[key].count += 1;
    playData.playCounts[key].lastPlayed = Date.now();
    // Update album in case it changed (same song on a different album/compilation)
    if (track.album) playData.playCounts[key].album = track.album;

    saveData(playData);

    // Push updated data to the renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data-update', {
        history: playData.history,
        playCounts: playData.playCounts,
      });
    }
  }

  // ---- IPC Handlers ----
  ipcMain.handle('get-data', () => ({
    history: playData.history,
    playCounts: playData.playCounts,
  }));

  // ---- Track polling ----
  function getScriptPath(filename) {
    const normalPath = path.join(__dirname, filename);
    if (app.isPackaged) {
      return normalPath.replace('app.asar', 'app.asar.unpacked');
    }
    return normalPath;
  }

  function getCurrentTrackWindows() {
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

  function getCurrentTrackMac() {
    return new Promise((resolve) => {
      const scriptPath = getScriptPath('get-track.applescript');
      const osa = spawn('osascript', [scriptPath]);

      let stdout = '';
      let stderr = '';

      osa.stdout.on('data', (d) => (stdout += d.toString()));
      osa.stderr.on('data', (d) => (stderr += d.toString()));

      osa.on('close', () => {
        if (stderr) log.warn('osascript stderr:', stderr.trim());
        const trimmed = stdout.trim();
        if (!trimmed || trimmed === 'not_running') return resolve({ state: 'not_running' });
        if (trimmed === 'stopped') return resolve({ state: 'stopped' });

        const parts = trimmed.split('<|>');
        if (parts.length !== 6) {
          log.warn('Unexpected AppleScript output:', trimmed);
          return resolve({ state: 'not_running' });
        }
        const [state, name, artist, album, durationStr, positionStr] = parts;
        resolve({
          state,
          name,
          artist,
          album,
          duration: parseFloat(durationStr) || 0,
          position: parseFloat(positionStr) || 0,
        });
      });

      osa.on('error', (err) => {
        log.error('Failed to spawn osascript:', err.message);
        resolve({ state: 'not_running' });
      });
    });
  }

  function getCurrentTrack() {
    if (process.platform === 'win32') return getCurrentTrackWindows();
    if (process.platform === 'darwin') return getCurrentTrackMac();
    if (!warnedUnsupportedPlatform) {
      log.warn(`${APP_NAME} doesn't support platform "${process.platform}" yet.`);
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
    });

    rpc.on('disconnected', () => {
      connected = false;
      log.info('Disconnected from Discord RPC');
      updateTrayMenu();
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

    // Try to get a public album art URL (Windows only, falls back to logo)
    const artworkUrl = await uploadArtworkToImgur(track.artworkPath || null);

    const activity = {
      details: track.name || 'Unknown track',
      state: track.artist ? `by ${track.artist}` : 'Unknown artist',
      largeImageKey: artworkUrl || 'itunes_logo',
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

  // ---- Imgur artwork upload (Windows only) ----
  const IMGUR_CLIENT_ID = '546c25a59c58ad7';
  const artworkCache = new Map(); // hash → imgur URL

  async function uploadArtworkToImgur(artworkPath) {
    if (!artworkPath || process.platform !== 'win32') return null;

    try {
      const fileBuffer = fs.readFileSync(artworkPath);
      if (!fileBuffer || fileBuffer.length === 0) return null;

      // Hash the file content so identical covers aren't re-uploaded
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');

      if (artworkCache.has(hash)) {
        return artworkCache.get(hash);
      }

      const base64 = fileBuffer.toString('base64');

      const response = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: {
          Authorization: `Client-ID ${IMGUR_CLIENT_ID}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: base64, type: 'base64' }),
      });

      if (!response.ok) {
        log.warn(`Imgur upload failed: HTTP ${response.status}`);
        return null;
      }

      const json = await response.json();
      const url = json?.data?.link;
      if (!url) return null;

      artworkCache.set(hash, url);
      log.info('Uploaded artwork to Imgur:', url);
      return url;
    } catch (err) {
      log.warn('Artwork upload error:', err.message);
      return null;
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
      currentTrackState = track;

      // Send live track state to the renderer window
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('track-update', track);
      }

      if (track.state === 'not_running' || track.state === 'stopped') {
        if (lastTrackKey !== null || !firstPollDone) {
          lastTrackKey = null;
          lastPosition = null;
          if (connected && rpc?.user) await rpc.user.clearActivity().catch(() => {});
          updateTrayTooltip(`${APP_NAME} — nothing playing`);
        }
      } else {
        const key = `${track.name}|${track.artist}|${track.state}`;

        const positionRewound =
          key === lastTrackKey &&
          lastPosition !== null &&
          track.position < lastPosition - 3;

        if (key !== lastTrackKey || positionRewound || !firstPollDone) {
          // Save the previous key BEFORE updating, so the track-change
          // comparison below works against what was actually playing before
          const previousKey = lastTrackKey;

          const pushedOk = await setPresence(track);
          if (pushedOk) {
            lastTrackKey = key;
          }

          // Record the play in history/leaderboard (only on actual track changes,
          // not on pause→play of the same song, and not on position rewinds)
          const trackChangeKey = `${track.name}|${track.artist}`;
          const prevTrackOnly = previousKey ? previousKey.replace(/\|(playing|paused)$/, '') : null;
          if (trackChangeKey !== prevTrackOnly && track.state === 'playing') {
            recordPlay(track);
          }

          updateTrayTooltip(`${track.state === 'playing' ? '▶' : '⏸'} ${track.name} — ${track.artist}`);
          log.info('Now:', track.state, track.name, '-', track.artist);
        }
        lastPosition = track.position;
      }
    } catch (err) {
      log.error('pollLoop error:', err.message);
      updateTrayTooltip(`${APP_NAME} — error, retrying...`);
    } finally {
      firstPollDone = true;
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
    }
  }

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
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: enabled ? 'Pause syncing' : 'Resume syncing',
        click: () => {
          enabled = !enabled;
          if (!enabled && connected && rpc?.user) rpc.user.clearActivity().catch(() => {});
          updateTrayMenu();
        },
      },
      {
        label: 'Check for updates',
        click: () => autoUpdater.checkForUpdatesAndNotify(),
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

  // ---- Main Window ----
  function createWindow() {
    const preloadPath = path.join(__dirname, 'preload.js');

    mainWindow = new BrowserWindow({
      width: 480,
      height: 640,
      minWidth: 380,
      minHeight: 480,
      backgroundColor: '#0d0d14',
      titleBarStyle: 'default',
      show: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Hide instead of close — the app keeps running in the tray
    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Remove default menu bar (File/Edit/View etc)
    mainWindow.setMenuBarVisibility(false);
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
  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.whenReady().then(() => {
    // macOS: menu-bar-only utility, hide the Dock icon
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
    }

    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip(`${APP_NAME} — starting...`);

    // Double-click tray icon shows the window
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    updateTrayMenu();
    createWindow();
    connectDiscord();
    pollLoop();

    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 5000);
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', (e) => {
    e?.preventDefault?.();
  });

  app.on('activate', () => {
    // macOS: clicking the dock icon re-shows the window
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
