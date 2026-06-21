// src/main.js
const { app, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const DiscordRPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// ---- CONFIG ----
// This is the app's Discord Application/Client ID (created once by the developer
// at https://discord.com/developers/applications). End users do NOT need their
// own ID -- everyone using iTunes2Discord shares this one, same as how every
// Spotify user shares Spotify's single Discord integration.
const CLIENT_ID = '1518362803008831769';

const POLL_INTERVAL_MS = 15000; // how often to check iTunes (15s is safe re: rate limits)
const APP_NAME = 'iTunes2Discord';

let tray = null;
let rpc = null;
let connected = false;
let lastTrackKey = null;
let pollTimer = null;
let enabled = true;

// ---- Logging (writes to %APPDATA%/itunes2discord/logs) ----
log.transports.file.level = 'info';
log.transports.console.level = 'info';
autoUpdater.logger = log;

// ---- iTunes polling via PowerShell/COM ----
function getCurrentTrack() {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'get-track.ps1');
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

// ---- Discord RPC ----
async function connectDiscord() {
  if (connected) return;
  rpc = new DiscordRPC.Client({ transport: 'ipc' });

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
    await rpc.login({ clientId: CLIENT_ID });
  } catch (err) {
    log.warn('Discord login failed (is Discord running?):', err.message);
    connected = false;
    setTimeout(connectDiscord, 10000);
  }
}

async function setPresence(track) {
  if (!connected || !rpc) {
    log.warn('Skipped presence update — not connected to Discord yet');
    return false;
  }

  if (track.state !== 'playing' && track.state !== 'paused') {
    await rpc.clearActivity().catch(() => {});
    return true;
  }

  const now = Date.now();
  const startTimestamp = Math.floor(now - track.position * 1000);
  const endTimestamp = Math.floor(now + (track.duration - track.position) * 1000);

  const activity = {
    details: track.name || 'Unknown track',
    state: track.artist ? `by ${track.artist}` : 'Unknown artist',
    largeImageKey: 'itunes_logo',
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
    await rpc.setActivity(activity);
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
        if (connected) await rpc.clearActivity().catch(() => {});
        updateTrayTooltip(`${APP_NAME} — iTunes not playing`);
      }
    } else {
      const key = `${track.name}|${track.artist}|${track.state}`;
      if (key !== lastTrackKey || !firstPollDone) {
        const pushedOk = await setPresence(track);
        if (pushedOk) {
          lastTrackKey = key;
        }
        updateTrayTooltip(`${track.state === 'playing' ? '▶' : '⏸'} ${track.name} — ${track.artist}`);
        log.info('Now:', track.state, track.name, '-', track.artist);
      }
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
      label: enabled ? 'Pause syncing' : 'Resume syncing',
      click: () => {
        enabled = !enabled;
        if (!enabled && connected) rpc.clearActivity().catch(() => {});
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
        if (connected && rpc) rpc.clearActivity().catch(() => {});
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
app.on('ready', () => {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip(`${APP_NAME} — starting...`);
  updateTrayMenu();

  connectDiscord();
  pollLoop();

  // Check for updates ~5s after launch, then silently every few hours
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 5000);
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', (e) => {
  e?.preventDefault?.();
});

// Single-instance lock — prevents two copies running at once
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
