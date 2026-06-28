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
// Forward reference: the second-instance listener below must be registered
// before runApp() executes (see comment above on why), but createWindow()
// itself isn't defined until runApp() runs. This lets the early listener
// call whatever runApp() later assigns here, instead of referencing a
// function that doesn't exist in this scope yet.
let showWindowFromOtherInstance = () => {};

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone double-clicked the Desktop/Start Menu shortcut (or relaunched
    // the .exe) while we were already running quietly in the tray. Bring
    // the live status window to front instead of silently ignoring it.
    showWindowFromOtherInstance();
  });

  runApp();
}

function runApp() {
  const DiscordRPC = require('@xhayper/discord-rpc');
  const { autoUpdater } = require('electron-updater');
  const log = require('electron-log');
  const {
    setLeaderboardEntry,
    listLeaderboardEntries,
    deleteLeaderboardEntry,
    getUsernameOwner,
    claimUsername,
  } = require('./firestore');

  // ---- CONFIG ----
  // This is the app's Discord Application/Client ID (created once by the developer
  // at https://discord.com/developers/applications). End users do NOT need their
  // own ID -- everyone using MusicToDiscord shares this one, same as how every
  // Spotify user shares Spotify's single Discord integration.
  const CLIENT_ID = '1519568889502105700';

  // Polling the music source (iTunes/SMTC) and pushing to Discord are now
  // decoupled. Discord's own docs say Rich Presence updates are rate-limited
  // to roughly one per 15 seconds, and calling setActivity too often doesn't
  // just get ignored -- it can make the presence stop updating and then go
  // blank entirely until calls stop for a while. So:
  //   - POLL_INTERVAL_MS: how often we check what's playing. Fast, since this
  //     only touches the local window/tray (no Discord call), so there's no
  //     rate-limit risk in checking often.
  //   - DISCORD_PUSH_MIN_INTERVAL_MS: the minimum time between actual
  //     setActivity calls. Track changes / resume-from-pause / first poll
  //     always push immediately regardless of this floor, since those are
  //     one-off events, not repeated spam -- only the "same song, just
  //     refreshing position" case gets throttled.
  const POLL_INTERVAL_MS = 3000;
  const DISCORD_PUSH_MIN_INTERVAL_MS = 15000;
  const APP_NAME = 'MusicToDiscord';

  // ---- Leaderboard config ----
  // Listening time is tracked locally every poll while a track is actively
  // playing, then pushed to Firestore periodically -- NOT every poll, since
  // that would mean one write per user every 3 seconds, which would burn
  // through Firestore's free-tier write quota fast with even a handful of
  // concurrent users. 60s strikes a reasonable balance: the leaderboard
  // updates often enough to feel "live" without writing constantly.
  const LEADERBOARD_SYNC_INTERVAL_MS = 60000;

  // ---- App settings (background, etc.) ----
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');

  function loadSettings() {
    try {
      if (fs.existsSync(settingsFile)) {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      }
    } catch (e) {
      log.warn('Failed to load settings:', e.message);
    }
    return {};
  }

  function saveSettings(settings) {
    try {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
      log.warn('Failed to save settings:', e.message);
    }
  }

  let appSettings = loadSettings();

  ipcMain.handle('get-settings', () => appSettings);

  ipcMain.handle('set-setting', (_event, key, value) => {
    appSettings[key] = value;
    saveSettings(appSettings);
    // Push to renderer so it can apply immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setting-changed', { key, value });
    }
    return true;
  });
  // Saved to disk at %APPDATA%/musictodiscord/play-history.json
  // Each entry: { name, artist, album, timestamp (ms), duration (s) }
  // Kept separate from Firestore -- this is purely local, richer data
  // used for the Wrapped feature. Capped at 10,000 entries.
  const historyFile = path.join(app.getPath('userData'), 'play-history.json');

  function loadHistory() {
    try {
      if (fs.existsSync(historyFile)) {
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      log.warn('Failed to load play history:', e.message);
    }
    return [];
  }

  let playHistory = loadHistory();

  function saveHistory() {
    try {
      if (playHistory.length > 10000) playHistory = playHistory.slice(-10000);
      fs.writeFileSync(historyFile, JSON.stringify(playHistory), 'utf8');
    } catch (e) {
      log.warn('Failed to save play history:', e.message);
    }
  }

  function recordPlay(track) {
    if (!track || !track.name) return;
    playHistory.push({
      name: track.name,
      artist: track.artist || '',
      album: track.album || '',
      timestamp: Date.now(),
      duration: track.duration || 0,
    });
    saveHistory();
  }

  let tray = null;
  let mainWindow = null;
  let rpc = null;
  let connected = false;
  let lastTrackKey = null;
  let lastPosition = null;
  let lastDiscordPushAt = 0; // Date.now() of the last actual setActivity call
  let lastTrackState = null; // cached for the window's initial state request
  let pollTimer = null;
  let enabled = true;
  let warnedUnsupportedPlatform = false;

  // ---- Leaderboard state ----
  let username = null; // null until the user has set one via the setup prompt
  let deviceId = null; // set once at startup via getOrCreateDeviceId()
  let devModeEnabled = false; // unlocked by typing the passcode into the username setup box
  let ownerModeEnabled = false; // unlocked by a separate, stronger passcode -- gold theme + dev mode + can temporarily disable the dev passcode
  let devPasscodeDisabledUntil = 0; // Date.now() timestamp; 0 means not disabled
  let devPasscodeDisableTimer = null;
  let sessionSecondsThisMonth = 0; // accumulated locally since last Firestore push
  let lastLeaderboardPushAt = 0;
  let leaderboardSyncTimer = null;

  // ---- Logging (writes to %APPDATA%/musictodiscord/logs) ----
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  autoUpdater.logger = log;

  // ---- Leaderboard username persistence ----
  // Stored as a tiny local JSON file in Electron's per-user data folder
  // (NOT in the project/install directory, which may not be writable and
  // wouldn't survive an update/reinstall anyway). Asked once on first
  // launch via the renderer's setup prompt; after that this file is the
  // source of truth, so the prompt never reappears unless the file is
  // deleted or the user explicitly changes their name in Settings.
  //
  // The same file also holds a deviceId -- a random ID generated once per
  // install and never shown in the UI. It's how username "ownership" is
  // tracked: when a name is claimed, this ID gets stored alongside it in
  // Firestore, so a different install trying to claim the same name can be
  // told "no, that's taken." This is a casual-collision guard between
  // friends, not real security -- there's no login or password involved,
  // so a determined person could still find a way around it. It solves the
  // actual problem (two people accidentally or jokingly grabbing the same
  // name), not a security problem.
  function getUsernameFilePath() {
    return path.join(app.getPath('userData'), 'username.json');
  }

  function loadUsername() {
    try {
      const raw = fs.readFileSync(getUsernameFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.username || null;
    } catch (e) {
      return null; // file doesn't exist yet, or is malformed -- either way, no username set
    }
  }

  function saveUsername(name) {
    try {
      const existing = readUsernameFile();
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ ...existing, username: name }),
        'utf8'
      );
      return true;
    } catch (e) {
      log.warn('Failed to save username:', e.message);
      return false;
    }
  }

  function readUsernameFile() {
    try {
      return JSON.parse(fs.readFileSync(getUsernameFilePath(), 'utf8'));
    } catch (e) {
      return {};
    }
  }

  // Returns this install's device ID, generating and persisting a new one
  // the very first time it's needed if one doesn't exist yet.
  function getOrCreateDeviceId() {
    const existing = readUsernameFile();
    if (existing.deviceId) return existing.deviceId;
    const deviceId = crypto.randomUUID();
    try {
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ ...existing, deviceId }),
        'utf8'
      );
    } catch (e) {
      log.warn('Failed to persist device ID:', e.message);
    }
    return deviceId;
  }

  function clearUsername() {
    try {
      const existing = readUsernameFile();
      // Keep deviceId (it's tied to this install, not to any one
      // username) but drop the username itself so the setup prompt
      // reappears on next launch.
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ deviceId: existing.deviceId }),
        'utf8'
      );
      return true;
    } catch (e) {
      log.warn('Failed to clear username:', e.message);
      return false;
    }
  }

  // ---- Dev mode ----
  // Unlocked by typing the passcode into the username setup box instead of
  // a real name -- main.js intercepts it in the set-username handler below
  // before it's ever treated as an actual username or sent to Firestore.
  // Persisted in the same local file as username/deviceId so it survives
  // restarts once unlocked.
  const DEV_MODE_PASSCODE = 'J@R3D';

  function loadDevMode() {
    return !!readUsernameFile().devMode;
  }

  function saveDevMode(enabled) {
    try {
      const existing = readUsernameFile();
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ ...existing, devMode: enabled }),
        'utf8'
      );
      return true;
    } catch (e) {
      log.warn('Failed to save dev mode flag:', e.message);
      return false;
    }
  }

  // ---- Owner mode ----
  // A second, separate passcode (stronger/rarer than the dev-mode one) that
  // unlocks everything dev mode does, PLUS a gold theme across the whole
  // window, PLUS the ability to temporarily turn off the regular dev-mode
  // passcode for an hour. Toggles on/off by typing the same code again --
  // unlike dev mode, this is meant to be flipped back off, not a one-way
  // unlock, so there's no separate "remove" action for it.
  const OWNER_MODE_PASSCODE = 'R3D_EYE';
  const DEV_PASSCODE_DISABLE_DURATION_MS = 60 * 60 * 1000; // 1 hour

  function loadOwnerMode() {
    return !!readUsernameFile().ownerMode;
  }

  function saveOwnerMode(enabled) {
    try {
      const existing = readUsernameFile();
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ ...existing, ownerMode: enabled }),
        'utf8'
      );
      return true;
    } catch (e) {
      log.warn('Failed to save owner mode flag:', e.message);
      return false;
    }
  }

  // Stored as an absolute timestamp (not a duration) so it survives an app
  // restart correctly -- if you disable the passcode then quit and reopen
  // the app 20 minutes later, it should still have ~40 minutes left, not
  // reset to a fresh hour.
  function loadDevPasscodeDisabledUntil() {
    const val = readUsernameFile().devPasscodeDisabledUntil;
    return typeof val === 'number' ? val : 0;
  }

  function saveDevPasscodeDisabledUntil(timestamp) {
    try {
      const existing = readUsernameFile();
      fs.writeFileSync(
        getUsernameFilePath(),
        JSON.stringify({ ...existing, devPasscodeDisabledUntil: timestamp }),
        'utf8'
      );
      return true;
    } catch (e) {
      log.warn('Failed to save dev passcode disable timestamp:', e.message);
      return false;
    }
  }

  // Schedules (or re-schedules) the moment the dev passcode automatically
  // starts working again. Safe to call multiple times -- clears any
  // existing timer first, so re-toggling owner mode mid-disable just resets
  // the clock to a fresh hour rather than stacking timers.
  function scheduleDevPasscodeReenable(untilTimestamp) {
    if (devPasscodeDisableTimer) {
      clearTimeout(devPasscodeDisableTimer);
      devPasscodeDisableTimer = null;
    }
    const msRemaining = untilTimestamp - Date.now();
    if (msRemaining <= 0) {
      devPasscodeDisabledUntil = 0;
      saveDevPasscodeDisabledUntil(0);
      return;
    }
    devPasscodeDisableTimer = setTimeout(() => {
      devPasscodeDisabledUntil = 0;
      saveDevPasscodeDisabledUntil(0);
      log.info('Dev mode passcode automatically re-enabled');
    }, msRemaining);
  }

  function getCurrentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Pulls this user's already-synced total for the current month, if any,
  // so an app restart resumes from where it left off instead of silently
  // resetting to 0 -- which would otherwise cause the next periodic sync to
  // overwrite Firestore with a lower number and erase previously-banked time.
  async function loadExistingMonthlyTotal() {
    if (!username) return 0;
    try {
      const entries = await listLeaderboardEntries();
      const month = getCurrentMonthKey();
      const mine = entries.find((e) => e.username === username && e.month === month);
      return mine && typeof mine.totalSeconds === 'number' ? mine.totalSeconds : 0;
    } catch (e) {
      log.warn('Failed to load existing leaderboard total:', e.message);
      return 0; // fail safe to 0 rather than block startup on a network issue
    }
  }

  // ---- Track polling (PowerShell/COM against iTunes, falling back to a
  // compiled smtc-helper.exe for Apple Music and other SMTC-aware apps) ----
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

  function getSmtcHelperPath() {
    // smtc-helper.exe is a separately-compiled C# program (not a script),
    // because PowerShell genuinely cannot extract the SMTC thumbnail bytes
    // -- two different ways, for two different structural reasons (see the
    // long comment at the top of smtc-helper/Program.cs for the full
    // story). It's bundled via electron-builder's "extraResources", NOT
    // asarUnpack, so -- unlike get-track.ps1 -- it never lives inside the
    // .asar at all and doesn't need the app.asar.unpacked rewrite trick.
    // extraResources lands directly in process.resourcesPath when packaged
    // (e.g. .../resources/smtc-helper/smtc-helper.exe); in dev mode (running
    // via `npm start`, not a built installer) it's just a sibling folder of
    // the project root instead.
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'smtc-helper', 'smtc-helper.exe');
    }
    return path.join(__dirname, '..', 'smtc-helper', 'publish', 'smtc-helper.exe');
  }

  function getCurrentTrackSMTC() {
    return new Promise((resolve) => {
      const exePath = getSmtcHelperPath();
      const proc = spawn(exePath, []);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', () => {
        if (stderr) log.warn('smtc-helper stderr:', stderr.trim());
        try {
          const trimmed = stdout.trim();
          if (!trimmed) return resolve({ state: 'not_running' });
          resolve(JSON.parse(trimmed));
        } catch (e) {
          log.warn('Failed to parse smtc-helper output:', stdout);
          resolve({ state: 'not_running' });
        }
      });

      proc.on('error', (err) => {
        log.error('Failed to spawn smtc-helper.exe:', err.message);
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
    // Windows' general media-session system. This was originally added
    // just to cover the Apple Music app for Windows (no public automation
    // API of its own), but SMTC isn't Apple-Music-specific: Spotify,
    // browser tabs playing YouTube Music/SoundCloud/etc, and most other
    // modern media apps register with it too, so this fallback now picks
    // up any of them automatically -- preferring whichever app is actually
    // playing if more than one has a session open at once.
    return getCurrentTrackSMTC();
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
          artworkPath: null, // Mac artwork support coming in a future version
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
    let largeImage = 'app_logo';
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
  let lastPollAt = null; // Date.now() of the previous poll, used to accumulate real elapsed listening time below

  async function pollLoop() {
    if (!enabled) {
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
      return;
    }

    try {
      const track = await getCurrentTrack();
      const now = Date.now();

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

        // Leaderboard: accumulate real elapsed wall-clock time since the
        // last poll, but only while actually playing (not paused) -- using
        // the real gap rather than assuming a flat POLL_INTERVAL_MS guards
        // against overcounting if a poll is ever slow, or the system was
        // asleep/suspended between polls. Capped at 2x the poll interval so
        // a long gap (laptop sleep, etc.) can't silently inflate someone's
        // total by however many hours the machine was actually asleep.
        if (track.state === 'playing' && lastPollAt !== null) {
          const elapsedSec = (now - lastPollAt) / 1000;
          const cappedSec = Math.min(elapsedSec, (POLL_INTERVAL_MS / 1000) * 2);
          if (cappedSec > 0) sessionSecondsThisMonth += cappedSec;
        }

        // Same song/state as last poll, but the position jumped backwards
        // (repeat-one looped, or the user scrubbed back) — without this,
        // the dedupe key never changes so Discord's elapsed-time bar would
        // silently go stale instead of restarting.
        const positionRewound =
          key === lastTrackKey &&
          lastPosition !== null &&
          track.position < lastPosition - 3;

        // Track changed, rewound, or this is the very first poll -> always
        // push to Discord right away, no throttling (these are one-off
        // events, not repeated spam). Otherwise (same song, same poll-to-poll
        // refresh) only push if the 15s floor has actually elapsed, so a fast
        // 3s local poll doesn't turn into a 3s Discord call rate.
        const isNewEvent = key !== lastTrackKey || positionRewound || !firstPollDone;
        const pushFloorElapsed = Date.now() - lastDiscordPushAt >= DISCORD_PUSH_MIN_INTERVAL_MS;

        if (isNewEvent || pushFloorElapsed) {
          const previousTrackKey = lastTrackKey;
          const pushedOk = await setPresence(track);
          if (pushedOk) {
            lastTrackKey = key;
            lastDiscordPushAt = Date.now();
          }

          // Record a play only on genuine track changes (not pause→play of
          // the same song, and not position rewinds -- those reuse the same
          // name+artist key as the song already playing).
          const newSongKey = `${track.name}|${track.artist}`;
          const prevSongKey = previousTrackKey ? previousTrackKey.replace(/\|(playing|paused)$/, '') : null;
          if (newSongKey !== prevSongKey && track.state === 'playing') {
            recordPlay(track);
          }

          updateTrayTooltip(`${track.state === 'playing' ? '▶' : '⏸'} ${track.name} — ${track.artist}`);
          log.info('Now:', track.state, track.name, '-', track.artist);
        }
        lastPosition = track.position;
        pushStateUpdate(track);
      }
      lastPollAt = now;
    } catch (err) {
      log.error('pollLoop error:', err.message);
      updateTrayTooltip(`${APP_NAME} — error, retrying...`);
    } finally {
      firstPollDone = true;
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
    }
  }

  // ---- Leaderboard sync ----
  // True once loadExistingMonthlyTotal() has resolved (or been skipped
  // because there's no username yet). Guards against a narrow startup race:
  // if the periodic sync timer or a quit-triggered push fired in the few
  // hundred ms before that background fetch resolves, sessionSecondsThisMonth
  // would still be its initial value, and pushing it would briefly overwrite
  // Firestore with a lower number than the user's real total -- self-
  // correcting on the next push, but better to just not push at all yet.
  let monthlyTotalLoaded = false;

  // Pushes the accumulated listening time to Firestore. Called periodically
  // (see leaderboardSyncTimer below) rather than every poll, and also once
  // immediately after a user sets their username for the first time.
  async function pushLeaderboardUpdate() {
    if (!username) return; // nothing to push until a name is set -- not worth logging, this is the normal pre-setup state
    if (!monthlyTotalLoaded) {
      // This used to return here completely silently, with no log line at
      // all -- which is exactly why a real bug (this early-return firing on
      // every single periodic sync, for reasons explained on
      // monthlyTotalLoaded below) was invisible in the logs and impossible
      // to diagnose from a user's report alone. Logging it now so a skipped
      // sync is at least visible, even though the fix below should mean
      // this should only ever be hit once, briefly, right at startup.
      log.warn('Leaderboard sync skipped — still waiting on startup total fetch');
      return;
    }
    const docId = `${username}_${getCurrentMonthKey()}`;
    try {
      await setLeaderboardEntry(docId, {
        username,
        month: getCurrentMonthKey(),
        totalSeconds: Math.round(sessionSecondsThisMonth),
        lastUpdated: new Date(),
        deviceId,
        appVersion: app.getVersion(),
        platform: process.platform, // 'win32' | 'darwin' | etc.
        osVersion: require('os').release(), // e.g. "10.0.26100"
      });
      lastLeaderboardPushAt = Date.now();
      log.info(`Leaderboard sync: ${username} -> ${Math.round(sessionSecondsThisMonth)}s this month`);
    } catch (e) {
      log.warn('Leaderboard sync failed:', e.message);
    }
  }

  function startLeaderboardSync() {
    if (leaderboardSyncTimer) clearInterval(leaderboardSyncTimer);
    leaderboardSyncTimer = setInterval(() => {
      pushLeaderboardUpdate().catch(() => {});
    }, LEADERBOARD_SYNC_INTERVAL_MS);
  }

  // ---- Main window ----
  function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 420,
      height: 680,
      minWidth: 320,
      minHeight: 400,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
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

  function detectImageMimeType(data) {
    // Same root issue as smtc-helper.exe's old hardcoded ".jpg": different
    // SMTC apps (Apple Music vs Windows Media Player, observed directly)
    // can hand back thumbnails in different image formats. Detecting the
    // real format from the file's magic bytes, rather than assuming JPEG,
    // avoids mislabeling a PNG/BMP in a way that could fail to render.
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return 'image/jpeg';
    }
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
      return 'image/bmp';
    }
    if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return 'image/gif';
    }
    return 'image/jpeg';
  }

  function artworkToDataUrl(artworkPath) {
    if (!artworkPath) return null;
    try {
      const data = fs.readFileSync(artworkPath);
      const mimeType = detectImageMimeType(data);
      return `data:${mimeType};base64,${data.toString('base64')}`;
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
    username,
    devMode: devModeEnabled,
    ownerMode: ownerModeEnabled,
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
    pushLeaderboardUpdate().finally(() => app.quit());
  });

  // ---- Leaderboard IPC ----
  // The renderer asks for this once on load to decide whether to show the
  // one-time "what's your Discord username?" setup prompt.
  ipcMain.handle('get-username', () => username);

  ipcMain.handle('set-username', async (_event, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };

    // Owner mode passcode -- a separate, stronger code that toggles owner
    // mode on/off. Checked BEFORE the dev passcode below so it's never
    // affected by the dev-passcode disable window (that window only ever
    // applies to DEV_MODE_PASSCODE itself, not this one -- otherwise
    // there'd be no way to re-enable things once disabled).
    if (trimmed === OWNER_MODE_PASSCODE) {
      ownerModeEnabled = !ownerModeEnabled;
      saveOwnerMode(ownerModeEnabled);
      if (ownerModeEnabled) {
        // Owner mode unlocks everything dev mode does too.
        devModeEnabled = true;
        saveDevMode(true);
        log.info('Owner mode unlocked');
      } else {
        log.info('Owner mode disabled');
      }
      return {
        ok: false,
        reason: ownerModeEnabled ? 'owner_mode_unlocked' : 'owner_mode_disabled',
      };
    }

    // Dev mode passcode -- intercepted here, before anything below treats
    // this as a real username. Never saved as a name, never sent to
    // Firestore, never claimed. Case-sensitive and exact on purpose: typos
    // should just fall through to "this is someone's actual username
    // attempt," not silently almost-unlock dev mode.
    //
    // If an owner has temporarily disabled this passcode, it's treated as
    // if it were just a regular (wrong) username attempt for the duration
    // of that window -- falls through to the normal claim-checking flow
    // below rather than unlocking anything.
    const devPasscodeCurrentlyDisabled = devPasscodeDisabledUntil > Date.now();
    if (trimmed === DEV_MODE_PASSCODE && !devPasscodeCurrentlyDisabled) {
      devModeEnabled = true;
      saveDevMode(true);
      log.info('Dev mode unlocked');
      return { ok: false, reason: 'dev_mode_unlocked' };
    }

    // If they're just re-saving the name they already have, there's
    // nothing to claim or check -- skip straight to "already fine."
    if (trimmed === username) {
      return { ok: true };
    }

    // Check ownership before claiming. A name is rejected only if it's
    // already claimed by a DIFFERENT device -- if it's unclaimed, or
    // already claimed by this exact device (e.g. they cleared their local
    // username file but Firestore still remembers this device claimed it
    // before), it's fine to proceed.
    try {
      const owner = await getUsernameOwner(trimmed);
      if (owner && owner !== deviceId) {
        return { ok: false, reason: 'taken' };
      }
    } catch (e) {
      log.warn('Username ownership check failed:', e.message);
      // Network/Firestore issue, not a real "taken" conflict -- fail
      // closed on the safe side (don't let a name through unchecked) but
      // give a distinct reason so the UI can say something more honest
      // than "taken."
      return { ok: false, reason: 'check_failed' };
    }

    const isActuallyChanging = trimmed !== username;
    username = trimmed;
    saveUsername(trimmed);

    try {
      await claimUsername(trimmed, deviceId);
    } catch (e) {
      log.warn('Failed to claim username:', e.message);
      // The local save above still happened, so the app keeps working --
      // worst case, someone else could theoretically grab the same name
      // before this retries. Not worth blocking the whole flow over.
    }

    if (isActuallyChanging) {
      // Switching to a different name (whether this is the very first
      // setup, or changing an existing name later) means whatever seconds
      // were accumulated so far this session belong to a DIFFERENT
      // leaderboard entry than the one we're about to write to. Look up
      // this name's own existing total instead of carrying the old
      // accumulator forward, which would incorrectly transplant one
      // person's progress onto another name's entry.
      monthlyTotalLoaded = false;
      sessionSecondsThisMonth = await loadExistingMonthlyTotal();
      monthlyTotalLoaded = true;
    }

    // Push an entry right away so a new/renamed user shows up on the
    // leaderboard immediately rather than waiting up to a minute for the
    // first periodic sync.
    pushLeaderboardUpdate().catch((e) => log.warn('Initial leaderboard push failed:', e.message));
    return { ok: true };
  });

  // "Delete my stats" -- removes this user's leaderboard entry for the
  // CURRENT month only (past months, if any survive, are left alone; there
  // isn't a UI for viewing past months anyway, so this matches what the
  // user can actually see and is reasoning about when they hit the button).
  // Does not affect the username claim itself -- the name stays theirs.
  ipcMain.handle('delete-my-stats', async () => {
    if (!username) return false;
    try {
      await deleteLeaderboardEntry(`${username}_${getCurrentMonthKey()}`);
      sessionSecondsThisMonth = 0;
      loadLeaderboardAfterChange();
      return true;
    } catch (e) {
      log.warn('Failed to delete leaderboard entry:', e.message);
      return false;
    }
  });

  // "Forget my username" -- clears the locally-saved name (so the setup
  // prompt reappears) WITHOUT deleting the Firestore leaderboard entry or
  // releasing the claim -- the name stays reserved for this device, so if
  // they set the same name again later, nothing about ownership changes.
  // Deleting stats (above) is a separate, explicit action.
  ipcMain.handle('clear-username', () => {
    username = null;
    sessionSecondsThisMonth = 0;
    monthlyTotalLoaded = true; // nothing to load for "no username"
    clearUsername();
    return true;
  });

  function loadLeaderboardAfterChange() {
    // Best-effort nudge so the renderer's leaderboard view (if currently
    // open) reflects a delete immediately rather than waiting for its own
    // 30s refresh -- mirrors how pushStateUpdate proactively notifies the
    // window elsewhere in this file instead of making the renderer poll.
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('leaderboard-changed');
  }

  // ---- Wrapped IPC ----
  ipcMain.handle('get-wrapped', (_event, monthKey) => {
    // monthKey format: "YYYY-MM". Defaults to current month.
    const month = monthKey || getCurrentMonthKey();
    const [year, mon] = month.split('-').map(Number);

    const start = new Date(year, mon - 1, 1).getTime();
    const end = new Date(year, mon, 1).getTime();

    const entries = playHistory.filter(
      (e) => e.timestamp >= start && e.timestamp < end
    );

    if (entries.length === 0) return null;

    // Top songs
    const songCounts = {};
    for (const e of entries) {
      const k = `${e.name}||${e.artist}`;
      if (!songCounts[k]) songCounts[k] = { name: e.name, artist: e.artist, album: e.album, count: 0 };
      songCounts[k].count++;
    }
    const topSongs = Object.values(songCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Top artists
    const artistCounts = {};
    for (const e of entries) {
      const k = e.artist || 'Unknown';
      if (!artistCounts[k]) artistCounts[k] = { artist: k, count: 0 };
      artistCounts[k].count++;
    }
    const topArtists = Object.values(artistCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Busiest hour (0-23)
    const hourCounts = new Array(24).fill(0);
    for (const e of entries) {
      hourCounts[new Date(e.timestamp).getHours()]++;
    }
    const busiestHour = hourCounts.indexOf(Math.max(...hourCounts));

    // Total plays and estimated listening time
    const totalPlays = entries.length;
    const totalSeconds = entries.reduce((sum, e) => sum + (e.duration || 0), 0);

    // Most active day
    const dayCounts = {};
    for (const e of entries) {
      const d = new Date(e.timestamp);
      const dk = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      dayCounts[dk] = (dayCounts[dk] || 0) + 1;
    }
    const mostActiveDay = Object.entries(dayCounts)
      .sort((a, b) => b[1] - a[1])[0];
    const mostActiveDayDate = mostActiveDay
      ? new Date(...mostActiveDay[0].split('-').map(Number))
      : null;

    return {
      month,
      totalPlays,
      totalSeconds: Math.round(totalSeconds),
      topSongs,
      topArtists,
      busiestHour,
      mostActiveDayLabel: mostActiveDayDate
        ? mostActiveDayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
        : null,
      mostActiveDayCount: mostActiveDay ? mostActiveDay[1] : 0,
    };
  });

  ipcMain.handle('get-wrapped-months', () => {
    // Returns a list of months that have any history, most recent first
    const months = new Set();
    for (const e of playHistory) {
      const d = new Date(e.timestamp);
      months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return [...months].sort().reverse();
  });

  // ---- Streaks ----
  ipcMain.handle('get-streaks', () => {
    if (playHistory.length === 0) return { current: 0, longest: 0, todayCount: 0 };

    const days = new Set();
    for (const e of playHistory) {
      const d = new Date(e.timestamp);
      days.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    const sorted = [...days].sort();

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const todayCount = playHistory.filter(e => {
      const d = new Date(e.timestamp);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === todayKey;
    }).length;

    // Longest streak
    let longest = 1, run = 1;
    for (let i = 1; i < sorted.length; i++) {
      const diff = (new Date(sorted[i]) - new Date(sorted[i-1])) / 86400000;
      if (diff === 1) { run++; longest = Math.max(longest, run); }
      else run = 1;
    }

    // Current streak working backwards from today or yesterday
    let current = 0;
    let checkMs = days.has(todayKey) ? new Date(todayKey).getTime() : new Date(todayKey).getTime() - 86400000;
    while (true) {
      const checkKey = new Date(checkMs).toISOString().slice(0, 10);
      if (!days.has(checkKey)) break;
      current++;
      checkMs -= 86400000;
    }

    return { current, longest, todayCount };
  });

  // ---- Recommendations ----
  // Songs by artists you haven't played much that appeared near your top
  // artists in recent listening sessions.
  ipcMain.handle('get-recommendations', () => {
    if (playHistory.length < 10) return [];

    const artistCounts = {};
    for (const e of playHistory) {
      const a = e.artist || 'Unknown';
      artistCounts[a] = (artistCounts[a] || 0) + 1;
    }

    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a]) => a);

    const lowPlayArtists = Object.entries(artistCounts)
      .filter(([a, c]) => !topArtists.includes(a) && c < 3)
      .map(([a]) => a);

    const recs = new Map();
    for (let i = 0; i < playHistory.length; i++) {
      const e = playHistory[i];
      if (!topArtists.includes(e.artist)) continue;
      for (let j = Math.max(0, i - 5); j < Math.min(playHistory.length, i + 6); j++) {
        if (j === i) continue;
        const near = playHistory[j];
        if (!near.artist || !lowPlayArtists.includes(near.artist)) continue;
        if (Math.abs(near.timestamp - e.timestamp) > 30 * 60 * 1000) continue;
        const key = `${near.name}||${near.artist}`;
        if (!recs.has(key)) recs.set(key, { name: near.name, artist: near.artist, score: 0 });
        recs.get(key).score++;
      }
    }

    return [...recs.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ name, artist }) => ({ name, artist }));
  });

  // ---- Shareable card ----
  ipcMain.handle('get-share-card', () => {
    if (!lastTrackState || lastTrackState.state === 'not_running' || lastTrackState.state === 'stopped') {
      return null;
    }
    return {
      name: lastTrackState.name || 'Unknown track',
      artist: lastTrackState.artist || 'Unknown artist',
      album: lastTrackState.album || '',
      artworkDataUrl: lastTrackState.artworkDataUrl || null,
      state: lastTrackState.state,
    };
  });

  ipcMain.handle('get-leaderboard', async () => {
    try {
      const entries = await listLeaderboardEntries();
      const month = getCurrentMonthKey();
      return entries
        .filter((e) => e.month === month && typeof e.totalSeconds === 'number')
        .sort((a, b) => b.totalSeconds - a.totalSeconds)
        .map((e) => ({ username: e.username, totalSeconds: e.totalSeconds }));
    } catch (e) {
      log.warn('Failed to fetch leaderboard:', e.message);
      return null; // null (vs []) tells the renderer this was a fetch error, not "genuinely empty"
    }
  });

  // ---- Dev mode ----
  // Unlocked via the passcode interception in set-username above. Nothing
  // here is gated server-side -- these handlers exist in every build, dev
  // mode just controls whether the renderer shows the tab that calls them.
  // That's an acceptable line for a personal/friends tool like this one
  // (these IPC channels aren't reachable from outside the app's own
  // renderer anyway, since contextIsolation is on and nothing exposes raw
  // ipcRenderer), but worth being clear it isn't a real permission system.

  ipcMain.handle('get-dev-mode', () => devModeEnabled);

  ipcMain.handle('get-owner-mode', () => ownerModeEnabled);

  // Disables the regular dev-mode passcode for an hour. Owner-mode-only --
  // checked here too (not just by hiding the button in the renderer),
  // since IPC handlers shouldn't rely solely on the UI not exposing a
  // control to actually enforce who can call them.
  ipcMain.handle('disable-dev-passcode', () => {
    if (!ownerModeEnabled) return false;
    devPasscodeDisabledUntil = Date.now() + DEV_PASSCODE_DISABLE_DURATION_MS;
    saveDevPasscodeDisabledUntil(devPasscodeDisabledUntil);
    scheduleDevPasscodeReenable(devPasscodeDisabledUntil);
    log.info('Dev mode passcode temporarily disabled for 1 hour by owner');
    return true;
  });

  // Lets the dev panel show a live countdown without the renderer trying
  // to do its own clock math against a raw timestamp it'd have to keep
  // re-fetching anyway.
  ipcMain.handle('get-dev-passcode-status', () => {
    const disabled = devPasscodeDisabledUntil > Date.now();
    return {
      disabled,
      msRemaining: disabled ? devPasscodeDisabledUntil - Date.now() : 0,
    };
  });

  // ---- Owner push notifications ----
  // Sends a native OS notification to this machine. Owner-mode-only.
  // Since the app has no server, this only fires on machines where the
  // app is currently running -- it's a broadcast to "anyone online now,"
  // not a true server push to all users.
  ipcMain.handle('send-owner-notification', (_event, { title, body }) => {
    if (!ownerModeEnabled) return false;
    const trimmedTitle = (title || '').trim();
    const trimmedBody = (body || '').trim();
    if (!trimmedTitle && !trimmedBody) return false;

    try {
      const { Notification } = require('electron');
      if (!Notification.isSupported()) {
        log.warn('Notifications not supported on this platform');
        return false;
      }
      const n = new Notification({
        title: trimmedTitle || APP_NAME,
        body: trimmedBody || '',
        icon: path.join(__dirname, '..', 'assets', 'tray-icon.png'),
      });
      n.show();
      log.info(`Owner notification sent: "${trimmedTitle}" — "${trimmedBody}"`);
      return true;
    } catch (e) {
      log.warn('Failed to send notification:', e.message);
      return false;
    }
  });

  // Every leaderboard entry, every user, every month -- unlike
  // get-leaderboard above, deliberately NOT filtered to the current month,
  // since a dev tool for poking at the data should see all of it.
  ipcMain.handle('dev-get-all-entries', async () => {
    if (!devModeEnabled) return null;
    try {
      const entries = await listLeaderboardEntries();
      return entries
        .filter((e) => typeof e.totalSeconds === 'number')
        .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : b.totalSeconds - a.totalSeconds))
        .map((e) => ({ id: e.id, username: e.username, month: e.month, totalSeconds: e.totalSeconds }));
    } catch (e) {
      log.warn('Dev mode: failed to fetch all entries:', e.message);
      return null;
    }
  });

  // Deletes ANY entry by its raw docId (e.g. "SomeoneElse_2026-06") --
  // not scoped to the current user. See the comment on
  // listLeaderboardEntries / firestore.rules for why this isn't
  // additionally gated server-side: today's delete rule is "allow delete:
  // if true" for everyone already, dev mode or not.
  ipcMain.handle('dev-delete-entry', async (_event, docId) => {
    if (!devModeEnabled) return false;
    if (!docId || typeof docId !== 'string') return false;
    try {
      await deleteLeaderboardEntry(docId);
      loadLeaderboardAfterChange();
      return true;
    } catch (e) {
      log.warn('Dev mode: failed to delete entry:', docId, e.message);
      return false;
    }
  });

  // Same as above, but takes a bare username instead of a full docId --
  // convenience for the "delete by name" box, since typing the exact
  // "name_YYYY-MM" format by hand is annoying and the current month is the
  // overwhelmingly common case for "I want to wipe this person's stats."
  ipcMain.handle('dev-delete-by-username', async (_event, targetUsername) => {
    if (!devModeEnabled) return false;
    const trimmed = (targetUsername || '').trim();
    if (!trimmed) return false;
    try {
      await deleteLeaderboardEntry(`${trimmed}_${getCurrentMonthKey()}`);
      loadLeaderboardAfterChange();
      return true;
    } catch (e) {
      log.warn('Dev mode: failed to delete by username:', trimmed, e.message);
      return false;
    }
  });

  // Live internal state -- the kind of thing you'd otherwise only see by
  // reading main.js's variables in a debugger. Recomputed fresh on every
  // call rather than cached, since the renderer polls this while the dev
  // tab is open and it should reflect what's happening right now.
  ipcMain.handle('dev-get-state', () => {
    if (!devModeEnabled) return null;
    return {
      connected,
      enabled,
      username,
      deviceId,
      sessionSecondsThisMonth: Math.round(sessionSecondsThisMonth),
      monthlyTotalLoaded,
      lastTrackKey,
      lastPosition,
      lastDiscordPushAt,
      lastLeaderboardPushAt,
      msSinceLastDiscordPush: lastDiscordPushAt ? Date.now() - lastDiscordPushAt : null,
      msSinceLastLeaderboardPush: lastLeaderboardPushAt ? Date.now() - lastLeaderboardPushAt : null,
      pollIntervalMs: POLL_INTERVAL_MS,
      discordPushMinIntervalMs: DISCORD_PUSH_MIN_INTERVAL_MS,
      leaderboardSyncIntervalMs: LEADERBOARD_SYNC_INTERVAL_MS,
      appVersion: app.getVersion(),
      monthKey: getCurrentMonthKey(),
    };
  });

  // Tails the actual log file on disk and returns the most recent
  // warning/error lines -- electron-log writes plain text lines prefixed
  // with a level like "[warn]" or "[error]", so a simple substring filter
  // is enough; no need to parse it as structured data for this.
  ipcMain.handle('dev-get-recent-errors', () => {
    if (!devModeEnabled) return null;
    try {
      const logPath = log.transports.file.getFile().path;
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const relevant = lines.filter((l) => /\[(warn|error)\]/i.test(l));
      return relevant.slice(-50); // most recent 50 -- this is a quick glance tool, not a full log viewer
    } catch (e) {
      log.warn('Dev mode: failed to read log file:', e.message);
      return null;
    }
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
          pushLeaderboardUpdate().finally(() => app.quit());
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }

  // ---- Auto-update state ----
  // Tracked here so pushStateUpdate() can include it in every state push,
  // meaning the renderer always knows the current update status without
  // needing a separate IPC call.
  let updateStatus = 'idle'; // 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  let updateVersion = null;

  function pushUpdateStatus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('update-status', { status: updateStatus, version: updateVersion });
  }

  // ---- Auto-update events ----
  autoUpdater.on('checking-for-update', () => {
    updateStatus = 'checking';
    pushUpdateStatus();
  });

  autoUpdater.on('update-available', (info) => {
    updateStatus = 'downloading';
    updateVersion = info.version;
    log.info(`Update available: v${info.version}, downloading...`);
    pushUpdateStatus();
  });

  autoUpdater.on('update-not-available', () => {
    updateStatus = 'idle';
    pushUpdateStatus();
  });

  autoUpdater.on('download-progress', () => {
    updateStatus = 'downloading';
    pushUpdateStatus();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateStatus = 'ready';
    updateVersion = info.version;
    log.info(`Update downloaded: v${info.version}`);
    pushUpdateStatus();
  });

  autoUpdater.on('error', (err) => {
    log.warn('Auto-update error:', err.message);
    updateStatus = 'error';
    pushUpdateStatus();
  });

  ipcMain.on('install-update', () => {
    if (updateStatus === 'ready') autoUpdater.quitAndInstall();
  });

  // ---- App lifecycle ----
  app.whenReady().then(() => {
    showWindowFromOtherInstance = createWindow;

    // Load a previously-saved Discord username, if any -- the renderer
    // checks this (via get-state/get-username) to decide whether to show
    // the one-time setup prompt. This is just a local file read, so it's
    // safe to do synchronously before anything else starts.
    username = loadUsername();
    deviceId = getOrCreateDeviceId();
    devModeEnabled = loadDevMode();
    ownerModeEnabled = loadOwnerMode();
    devPasscodeDisabledUntil = loadDevPasscodeDisabledUntil();
    if (devPasscodeDisabledUntil > Date.now()) {
      // A disable window was already in progress when the app last closed
      // -- pick up where it left off rather than resetting to a fresh hour.
      scheduleDevPasscodeReenable(devPasscodeDisabledUntil);
    } else if (devPasscodeDisabledUntil !== 0) {
      // Stored timestamp is in the past (app was closed longer than the
      // disable window lasted) -- clean it up so future reads are simple.
      devPasscodeDisabledUntil = 0;
      saveDevPasscodeDisabledUntil(0);
    }

    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip(`${APP_NAME} — starting...`);
    updateTrayMenu();

    // Spec: single click opens the window (right-click still shows the
    // context menu via setContextMenu, which Electron handles separately
    // from this click event on Windows/Linux).
    tray.on('click', () => createWindow());

    // Open the window on launch too — clicking the app's own icon (Desktop
    // or Start Menu shortcut) should feel like opening a normal app, not
    // silently dropping you into the tray with no visible window at all.
    createWindow();

    connectDiscord();
    pollLoop();

    // Fetch this user's already-synced monthly total BEFORE starting the
    // periodic sync timer below -- deliberately not blocking window/tray/
    // poll startup above on this network call, since Firestore could be
    // slow or unreachable and the core "show what's playing" experience
    // must never be gated on that. But the sync timer itself DOES need to
    // wait: starting it immediately (the original approach) created a real
    // race -- if this fetch was still in flight when the first 60s tick
    // fired, that sync (and potentially more) got silently dropped, since
    // pushLeaderboardUpdate() refused to push without a loaded baseline.
    // That's exactly what was happening: every restart re-triggered the
    // race, with zero logging to reveal it, so the leaderboard always
    // lagged behind real listening time. Waiting for the fetch to settle
    // before starting the timer removes the race rather than just gating
    // around it.
    if (username) {
      loadExistingMonthlyTotal().then((existing) => {
        sessionSecondsThisMonth = existing;
        monthlyTotalLoaded = true;
        startLeaderboardSync();
      });
    } else {
      // No username yet -- still start the timer so that once the user
      // completes the setup prompt and set-username fires, periodic syncs
      // are already running rather than needing yet another start call.
      monthlyTotalLoaded = true;
      startLeaderboardSync();
    }

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
