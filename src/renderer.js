// src/renderer.js
const elStatusDot = document.getElementById('status-dot');
const elStatusText = document.getElementById('status-text');
const elTrackName = document.getElementById('track-name');
const elTrackArtist = document.getElementById('track-artist');
const elArtImg = document.getElementById('art-img');
const elArtFallback = document.getElementById('art-fallback');
const elGrooveFill = document.getElementById('groove-fill');
const elGrooveNeedle = document.getElementById('groove-needle');
const elTimeElapsed = document.getElementById('time-elapsed');
const elTimeRemaining = document.getElementById('time-remaining');
const elTimerDisplay = document.getElementById('timer-display');
const elToggleSync = document.getElementById('toggle-sync');
const elToggleTextures = document.getElementById('toggle-textures');
const elVersionSub = document.getElementById('version-sub');
const elBtnUpdate = document.getElementById('btn-update');
const elBtnQuit = document.getElementById('btn-quit');
const elBtnMin = document.getElementById('btn-min');
const elBtnClose = document.getElementById('btn-close');

// ---- Animation helpers ----
// Re-trigger a one-shot CSS animation by removing the class, forcing a
// reflow, then re-adding it. Without the reflow the browser coalesces the
// remove+add and the animation never replays.
function replayAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth; // force reflow
  el.classList.add(className);
}

// Animate a number from 0 up to its target value over ~0.8s using
// requestAnimationFrame with an ease-out curve. Falls back to setting the
// final value directly if reduced motion is preferred.
function countUp(el, target) {
  if (!el) return;
  const finalText = (target || 0).toLocaleString();
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = finalText;
    return;
  }
  const duration = 800;
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = Math.round(eased * target).toLocaleString();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = finalText;
    }
  }
  requestAnimationFrame(frame);
}

// Track the last-rendered song so we only fire the change animations when the
// song actually changes, not on every 1s position tick.
let lastAnimatedSongKey = null;

// ---- Dynamic theme from album art ----
// Extracts a dominant color from the current cover and retints the UI. The
// extracted color drives an accent variable; backgrounds are derived as very
// dark tints of it so text stays readable regardless of how bright/pale the
// cover is. A hidden canvas does the pixel sampling.
const themeCanvas = document.createElement('canvas');
const themeCtx = themeCanvas.getContext('2d', { willReadFrequently: true });

function applyThemeFromArtwork(dataUrl) {
  if (!dataUrl) { resetTheme(); return; }
  const img = new Image();
  // Remote covers (iTunes CDN) would otherwise taint the canvas and make
  // getImageData() throw. Apple's CDN sends permissive CORS headers, so
  // requesting the image anonymously lets us read its pixels. Harmless for
  // local data: URLs, which are same-origin anyway.
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      // Downscale heavily -- we only need an average/dominant hue, not detail.
      const w = 32, h = 32;
      themeCanvas.width = w;
      themeCanvas.height = h;
      themeCtx.drawImage(img, 0, 0, w, h);
      const { data } = themeCtx.getImageData(0, 0, w, h);

      // Bucket pixels by coarse hue and pick the most saturated/frequent one,
      // skipping near-black and near-white pixels which make poor accents.
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      let best = null, bestScore = -1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 200) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lum = (max + min) / 2;
        const sat = max === 0 ? 0 : (max - min) / max;
        // Skip extremes
        if (lum < 25 || lum > 235) continue;
        rSum += r; gSum += g; bSum += b; count++;
        // Prefer vivid colors as the accent
        const score = sat * 255 + (max - min);
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }

      if (count === 0 || !best) { resetTheme(); return; }

      // Accent = the most vivid pixel; nudge it brighter so it pops on dark bg.
      let [ar, ag, ab] = best;
      [ar, ag, ab] = brighten(ar, ag, ab, 1.15);
      const accent = `rgb(${ar}, ${ag}, ${ab})`;

      // Backgrounds = very dark tints of the average color, so the whole UI
      // feels colored by the art but stays dark enough for white text.
      const avgR = rSum / count, avgG = gSum / count, avgB = bSum / count;
      const bg = `rgb(${Math.round(avgR * 0.10 + 10)}, ${Math.round(avgG * 0.10 + 10)}, ${Math.round(avgB * 0.10 + 12)})`;
      const bgRaised = `rgb(${Math.round(avgR * 0.16 + 16)}, ${Math.round(avgG * 0.16 + 16)}, ${Math.round(avgB * 0.16 + 20)})`;

      const root = document.documentElement;
      root.style.setProperty('--indigo', accent);
      root.style.setProperty('--sky', accent);
      root.style.setProperty('--dyn-bg', bg);
      root.style.setProperty('--dyn-bg-raised', bgRaised);
      document.body.classList.add('dynamic-theme');
    } catch (e) {
      // Tainted canvas or any failure -> just fall back to the default theme.
      resetTheme();
    }
  };
  img.onerror = () => resetTheme();
  img.src = dataUrl;
}

function brighten(r, g, b, factor) {
  return [
    Math.min(255, Math.round(r * factor)),
    Math.min(255, Math.round(g * factor)),
    Math.min(255, Math.round(b * factor)),
  ];
}

function resetTheme() {
  const root = document.documentElement;
  root.style.removeProperty('--indigo');
  root.style.removeProperty('--sky');
  root.style.removeProperty('--dyn-bg');
  root.style.removeProperty('--dyn-bg-raised');
  document.body.classList.remove('dynamic-theme');
}

// Leaderboard / tabs
const elTabBtnNowPlaying = document.getElementById('tab-btn-now-playing');
const elTabBtnLeaderboard = document.getElementById('tab-btn-leaderboard');
const elTabBtnWrapped = document.getElementById('tab-btn-wrapped');
const elTabBtnShare = document.getElementById('tab-btn-share');
const elTabBtnRecs = document.getElementById('tab-btn-recs');
const elTabBtnSettings = document.getElementById('tab-btn-settings');
const elTabBtnDev = document.getElementById('tab-btn-dev');
const elUpdateBanner = document.getElementById('update-banner');
const elUpdateBannerText = document.getElementById('update-banner-text');
const elUpdateBannerBtn = document.getElementById('update-banner-btn');
const elLeaderboardMonth = document.getElementById('leaderboard-month');
const elLeaderboardList = document.getElementById('leaderboard-list');
const elLeaderboardEmpty = document.getElementById('leaderboard-empty');
const elLeaderboardError = document.getElementById('leaderboard-error');

// Dev mode
const elDevStateGrid = document.getElementById('dev-state-grid');
const elDevErrorsList = document.getElementById('dev-errors-list');
const elDevErrorsEmpty = document.getElementById('dev-errors-empty');
const elDevEntriesList = document.getElementById('dev-entries-list');
const elDevEntriesEmpty = document.getElementById('dev-entries-empty');
const elDevDeleteInput = document.getElementById('dev-delete-input');
const elDevDeleteByNameBtn = document.getElementById('dev-delete-by-name-btn');
const elDevBanInput = document.getElementById('dev-ban-input');
const elDevBanBtn = document.getElementById('dev-ban-btn');
const elDevUnbanBtn = document.getElementById('dev-unban-btn');
const elDevBannedList = document.getElementById('dev-banned-list');

// Owner mode
const elDevOwnerSection = document.getElementById('dev-owner-section');
const elDevPasscodeStatus = document.getElementById('dev-passcode-status');
const elDevDisablePasscodeBtn = document.getElementById('dev-disable-passcode-btn');

// Username setup overlay
const elSetupOverlay = document.getElementById('setup-overlay');
const elSetupInput = document.getElementById('setup-input');
const elSetupSubmit = document.getElementById('setup-submit');
const elSetupSkip = document.getElementById('setup-skip');
const elSetupError = document.getElementById('setup-error');

// Username settings row
const elUsernameSub = document.getElementById('username-sub');
const elBtnChangeUsername = document.getElementById('btn-change-username');
const elBtnRemoveUsername = document.getElementById('btn-remove-username');
const elBtnDeleteStats = document.getElementById('btn-delete-stats');
const elBtnResetWrapped = document.getElementById('btn-reset-wrapped');

let currentUsername = null;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- Local real-time ticking ----
// state-update arrives every ~3s (the local poll rate -- separate from the
// slower 15s floor on actual Discord pushes). Between updates we extrapolate
// the displayed position forward locally, once per second, so the bar/timer
// flow smoothly instead of only moving every 3s.
//
// Every state-update re-anchors to the freshly-reported position -- that
// reading is always more trustworthy than our local extrapolation, so we
// don't try to "ignore small disagreements" the way an earlier version of
// this code did. That earlier approach caused a real bug: when a poll's
// reported position differed from our running estimate by less than its
// tolerance, the code skipped resyncing entirely, so any drift between the
// real position and our local clock (e.g. from the source's own measurement
// lag, or just accumulated rounding) persisted and compounded forever
// instead of ever being corrected -- it looked like the displayed time
// quietly running ahead of or behind the real song.
let liveTrack = null;
let liveAnchorMs = 0;

function reanchor(newTrack) {
  liveTrack = newTrack;
  liveAnchorMs = Date.now();
  // Repaint immediately on every reanchor, not just on the next 1s tick.
  // Without this, there's a window (up to ~1s) where the screen still shows
  // a value extrapolated from the OLD anchor even though we already have
  // fresher, more accurate data -- and because the setInterval below runs on
  // its own independent schedule rather than one realigned to each reanchor,
  // whichever of the two "wins" a given instant was effectively random. That
  // produced visible back-and-forth: a stale extrapolated frame occasionally
  // rendering after a fresher one, depending on exact timing. Painting right
  // here removes that race -- the freshest data is always shown the moment
  // it arrives, and the interval below just keeps things moving smoothly in
  // between arrivals.
  paintTime();
}

function paintTime() {
  if (!liveTrack) return;
  const isPlaying = liveTrack.state === 'playing';
  const elapsedSinceAnchor = isPlaying ? (Date.now() - liveAnchorMs) / 1000 : 0;
  const position = Math.min(liveTrack.duration || 0, (liveTrack.position || 0) + elapsedSinceAnchor);
  const duration = liveTrack.duration || 0;
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const remaining = Math.max(0, duration - position);

  elGrooveFill.style.width = `${pct}%`;
  elGrooveNeedle.style.left = `${pct}%`;
  elTimeElapsed.textContent = formatTime(position);
  elTimeRemaining.textContent = `\u2212${formatTime(remaining)}`;

  // The big countdown timer is the same number as time-remaining above —
  // it ticks down once per second while playing (driven by the 1s interval
  // below) and holds perfectly still the instant the track is paused, since
  // elapsedSinceAnchor is forced to 0 above when isPlaying is false.
  elTimerDisplay.textContent = formatTime(remaining);
  elTimerDisplay.classList.toggle('paused', !isPlaying);
}

setInterval(paintTime, 1000);

function render(state) {
  if (!state) return;

  // Connection status dot + label
  if (state.connected) {
    elStatusDot.className = 'live';
    elStatusText.textContent = 'Connected to Discord';
  } else {
    elStatusDot.className = 'off';
    elStatusText.textContent = 'Not connected to Discord';
  }

  // Track info
  const track = state.track;
  if (track && (track.state === 'playing' || track.state === 'paused')) {
    // Drives the equalizer bars, groove shimmer, and album-art float -- only
    // while actually playing, so paused freezes them.
    document.body.classList.toggle('is-playing', track.state === 'playing');
    elTrackName.textContent = track.name || 'Unknown track';
    elTrackArtist.textContent = track.artist || 'Unknown artist';

    // Fire cross-fade animations only when the song genuinely changes, so the
    // name/artist/art don't re-animate on every per-second position tick.
    const songKey = `${track.name}|${track.artist}`;
    const songChanged = songKey !== lastAnimatedSongKey;
    if (songChanged) {
      replayAnimation(elTrackName, 'text-animate');
      replayAnimation(elTrackArtist, 'text-animate');
      lastAnimatedSongKey = songKey;
    }

    reanchor(track);
    paintTime();

    // Album art source: prefer the iTunes HTTP cover (works for Apple Music),
    // fall back to the local data URL (classic iTunes), else the fallback img.
    const artSrc = track.artworkHttpUrl || track.artworkDataUrl || null;
    if (artSrc) {
      elArtImg.src = artSrc;
      elArtImg.style.display = 'block';
      elArtFallback.style.display = 'none';
      if (songChanged) replayAnimation(elArtImg, 'art-animate');
      // Dynamic theme: pull the dominant color from the new cover and retint
      // the UI. Only on song change so we don't re-extract every tick.
      if (songChanged) applyThemeFromArtwork(artSrc);
    } else {
      elArtImg.style.display = 'none';
      elArtFallback.style.display = 'flex';
      if (songChanged) replayAnimation(elArtFallback, 'art-animate');
      if (songChanged) resetTheme();
    }
  } else {
    liveTrack = null;
    lastAnimatedSongKey = null;
    document.body.classList.remove('is-playing');
    resetTheme();
    elTrackName.textContent = 'Nothing playing';
    elTrackArtist.textContent = 'Open Apple Music and press play';
    elGrooveFill.style.width = '0%';
    elGrooveNeedle.style.left = '0%';
    elTimeElapsed.textContent = '0:00';
    elTimeRemaining.textContent = '\u22120:00';
    elTimerDisplay.textContent = '0:00';
    elTimerDisplay.classList.add('paused');
    elArtImg.style.display = 'none';
    elArtFallback.style.display = 'flex';
  }

  // Sync toggle reflects whether polling/pushing is currently enabled
  elToggleSync.classList.toggle('on', !!state.syncEnabled);
  elToggleSync.setAttribute('aria-checked', String(!!state.syncEnabled));

  if (state.version) {
    elVersionSub.textContent = `v${state.version}`;
  }

  if (typeof state.username !== 'undefined') {
    currentUsername = state.username;
    elUsernameSub.textContent = currentUsername ? currentUsername : 'Not set';
    elBtnRemoveUsername.style.display = currentUsername ? 'block' : 'none';
    elBtnDeleteStats.disabled = !currentUsername;
  }

  if (typeof state.devMode !== 'undefined') {
    elTabBtnDev.style.display = state.devMode ? '' : 'none';
    // If dev tab is active but dev mode got disabled, switch back to now playing
    if (!state.devMode && document.body.classList.contains('tab-dev')) {
      showTab('now-playing');
    }
  }

  if (typeof state.ownerMode !== 'undefined') {
    document.body.classList.toggle('owner-mode', !!state.ownerMode);
  }
}

// ---- Leaderboard ----

function formatListeningTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderLeaderboard(entries) {
  elLeaderboardList.innerHTML = '';
  elLeaderboardEmpty.style.display = 'none';
  elLeaderboardError.style.display = 'none';

  const now = new Date();
  const monthLabel = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  elLeaderboardMonth.textContent = monthLabel;

  if (entries === null) {
    document.getElementById('battle-card').style.display = 'none';
    elLeaderboardError.style.display = 'block';
    return;
  }
  if (entries.length === 0) {
    document.getElementById('battle-card').style.display = 'none';
    elLeaderboardEmpty.style.display = 'block';
    return;
  }

  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    if (currentUsername && entry.username === currentUsername) {
      row.classList.add('me');
    }
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name"></span>
      <span class="lb-time"></span>
    `;
    // Set text via textContent (not innerHTML) so a username can never be
    // interpreted as markup -- usernames are arbitrary user input from
    // potentially many different people, shared across everyone's window.
    row.querySelector('.lb-name').textContent = entry.username || 'Unknown';
    row.querySelector('.lb-time').textContent = formatListeningTime(entry.totalSeconds);
    // Stagger each row's entrance slightly so the list cascades in instead of
    // appearing all at once. Capped so a long list doesn't take forever.
    row.classList.add('row-animate');
    row.style.animationDelay = `${Math.min(i * 0.04, 0.5)}s`;
    elLeaderboardList.appendChild(row);
  });

  // Build the battle card from the same entries.
  updateBattleCard(entries);
}

// ---- Listening battle ----
// A head-to-head built entirely from leaderboard entries already loaded:
// you vs whichever opponent you pick. No extra backend needed.
let battleEntries = [];
let battleOpponent = null; // remembered across refreshes so it doesn't reset

function updateBattleCard(entries) {
  const card = document.getElementById('battle-card');
  const select = document.getElementById('battle-select');
  const result = document.getElementById('battle-result');

  battleEntries = entries || [];

  // Need a username set and at least one OTHER person to battle.
  const me = battleEntries.find((e) => e.username === currentUsername);
  const others = battleEntries.filter((e) => e.username !== currentUsername);
  if (!currentUsername || !me || others.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  // Populate the opponent dropdown, preserving the current pick if still valid.
  const validOpponent = others.some((e) => e.username === battleOpponent);
  if (!validOpponent) battleOpponent = others[0].username;
  select.innerHTML = others
    .map((e) => `<option value="${esc(e.username)}"${e.username === battleOpponent ? ' selected' : ''}>${esc(e.username)}</option>`)
    .join('');
  select.onchange = () => {
    battleOpponent = select.value;
    renderBattleResult();
  };

  renderBattleResult();
}

function renderBattleResult() {
  const result = document.getElementById('battle-result');
  const me = battleEntries.find((e) => e.username === currentUsername);
  const them = battleEntries.find((e) => e.username === battleOpponent);
  if (!me || !them) { result.innerHTML = ''; return; }

  const mySec = me.totalSeconds || 0;
  const theirSec = them.totalSeconds || 0;
  const total = mySec + theirSec;
  const myPct = total > 0 ? (mySec / total) * 100 : 50;
  const theirPct = 100 - myPct;

  let verdict, verdictClass;
  if (mySec > theirSec) {
    verdict = `You're ahead by ${formatListeningTime(mySec - theirSec)}`;
    verdictClass = 'winning';
  } else if (theirSec > mySec) {
    verdict = `Behind by ${formatListeningTime(theirSec - mySec)} — catch up!`;
    verdictClass = 'losing';
  } else {
    verdict = "Dead even — it's a tie!";
    verdictClass = 'tied';
  }

  result.innerHTML = `
    <div class="battle-vs">
      <div class="battle-side me">
        <div class="battle-name">${esc(currentUsername)} (you)</div>
        <div class="battle-time">${formatListeningTime(mySec)}</div>
      </div>
      <div class="battle-vs-divider">VS</div>
      <div class="battle-side">
        <div class="battle-name">${esc(battleOpponent)}</div>
        <div class="battle-time">${formatListeningTime(theirSec)}</div>
      </div>
    </div>
    <div class="battle-bar">
      <div class="battle-bar-me" style="width:${myPct}%"></div>
      <div class="battle-bar-them" style="width:${theirPct}%"></div>
    </div>
    <div class="battle-verdict ${verdictClass}">${verdict}</div>
  `;
}

let leaderboardRefreshTimer = null;

function loadLeaderboard() {
  window.musicToDiscord.getLeaderboard().then(renderLeaderboard);
}

let devRefreshTimer = null;

function showTab(tab) {
  document.body.classList.toggle('tab-leaderboard', tab === 'leaderboard');
  document.body.classList.toggle('tab-dev', tab === 'dev');
  document.body.classList.toggle('tab-wrapped', tab === 'wrapped');
  document.body.classList.toggle('tab-share', tab === 'share');
  document.body.classList.toggle('tab-recs', tab === 'recs');
  document.body.classList.toggle('tab-settings', tab === 'settings');
  elTabBtnNowPlaying.classList.toggle('active', tab === 'now-playing');
  elTabBtnLeaderboard.classList.toggle('active', tab === 'leaderboard');
  elTabBtnDev.classList.toggle('active', tab === 'dev');
  elTabBtnWrapped.classList.toggle('active', tab === 'wrapped');
  elTabBtnShare.classList.toggle('active', tab === 'share');
  elTabBtnRecs.classList.toggle('active', tab === 'recs');
  elTabBtnSettings.classList.toggle('active', tab === 'settings');

  if (tab === 'leaderboard') {
    loadLeaderboard();
    if (!leaderboardRefreshTimer) {
      leaderboardRefreshTimer = setInterval(loadLeaderboard, 30000);
    }
  } else if (leaderboardRefreshTimer) {
    clearInterval(leaderboardRefreshTimer);
    leaderboardRefreshTimer = null;
  }

  if (tab === 'dev') {
    refreshDevPanel();
    if (!devRefreshTimer) {
      devRefreshTimer = setInterval(refreshDevPanel, 3000);
    }
  } else if (devRefreshTimer) {
    clearInterval(devRefreshTimer);
    devRefreshTimer = null;
  }

  if (tab === 'wrapped') loadWrapped();
  if (tab === 'share') loadShareCard();
  if (tab === 'recs') loadRecommendations();
}

elTabBtnNowPlaying.addEventListener('click', () => showTab('now-playing'));
elTabBtnLeaderboard.addEventListener('click', () => showTab('leaderboard'));
elTabBtnDev.addEventListener('click', () => showTab('dev'));
elTabBtnWrapped.addEventListener('click', () => showTab('wrapped'));
elTabBtnShare.addEventListener('click', () => showTab('share'));
elTabBtnRecs.addEventListener('click', () => showTab('recs'));
elTabBtnSettings.addEventListener('click', () => showTab('settings'));

// ---- Dev mode ----
function formatDevValue(val) {
  if (val === null || typeof val === 'undefined') return '—';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

function renderDevStateGrid(state) {
  elDevStateGrid.innerHTML = '';
  if (!state) return;
  Object.entries(state).forEach(([key, value]) => {
    const cell = document.createElement('div');
    cell.className = 'dev-stat';
    cell.innerHTML = '<div class="dev-stat-key"></div><div class="dev-stat-val"></div>';
    cell.querySelector('.dev-stat-key').textContent = key;
    cell.querySelector('.dev-stat-val').textContent = formatDevValue(value);
    elDevStateGrid.appendChild(cell);
  });
}

function renderDevErrors(lines) {
  elDevErrorsList.innerHTML = '';
  elDevErrorsEmpty.style.display = 'none';
  if (!lines || lines.length === 0) {
    elDevErrorsEmpty.style.display = 'block';
    return;
  }
  // Most recent first -- main.js returns oldest-to-newest (tail of the
  // file, in file order), reverse here so the newest is at the top where
  // it's immediately visible without scrolling.
  [...lines].reverse().forEach((line) => {
    const div = document.createElement('div');
    div.className = 'dev-error-line';
    div.textContent = line;
    elDevErrorsList.appendChild(div);
  });
}

function renderDevEntries(entries) {
  elDevEntriesList.innerHTML = '';
  elDevEntriesEmpty.style.display = 'none';
  if (!entries || entries.length === 0) {
    elDevEntriesEmpty.style.display = 'block';
    return;
  }
  entries.forEach((entry) => {
    const platformLabel = entry.platform === 'win32' ? 'Win'
      : entry.platform === 'darwin' ? 'Mac'
      : entry.platform || '?';
    const versionLabel = entry.appVersion ? `v${entry.appVersion}` : '';
    const osLabel = entry.osVersion ? entry.osVersion : '';
    const infoLabel = [platformLabel, osLabel, versionLabel].filter(Boolean).join(' · ');

    const row = document.createElement('div');
    row.className = 'dev-entry-row';
    row.innerHTML = `
      <div class="dev-entry-info">
        <span class="dev-entry-name"></span>
        <span class="dev-entry-meta"></span>
      </div>
      <span class="dev-entry-month"></span>
      <span class="dev-entry-time"></span>
      <button class="dev-entry-delete">DEL</button>
    `;
    row.querySelector('.dev-entry-name').textContent = entry.username || 'Unknown';
    row.querySelector('.dev-entry-meta').textContent = infoLabel;
    row.querySelector('.dev-entry-month').textContent = entry.month || '';
    row.querySelector('.dev-entry-time').textContent = formatListeningTime(entry.totalSeconds);
    row.querySelector('.dev-entry-delete').addEventListener('click', () => {
      window.musicToDiscord.devDeleteEntry(entry.id).then(() => refreshDevPanel());
    });
    elDevEntriesList.appendChild(row);
  });
}

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function refreshDevPanel() {
  window.musicToDiscord.devGetState().then(renderDevStateGrid);
  window.musicToDiscord.devGetRecentErrors().then(renderDevErrors);
  window.musicToDiscord.devGetAllEntries().then(renderDevEntries);
  loadBannedList();

  window.musicToDiscord.getOwnerMode().then((isOwner) => {
    elDevOwnerSection.style.display = isOwner ? 'block' : 'none';
    if (!isOwner) return;
    window.musicToDiscord.getDevPasscodeStatus().then((status) => {
      if (status && status.disabled) {
        elDevPasscodeStatus.textContent = `Dev passcode disabled — back on in ${formatRemaining(status.msRemaining)}`;
        elDevDisablePasscodeBtn.disabled = true;
      } else {
        elDevPasscodeStatus.textContent = 'Dev passcode is active';
        elDevDisablePasscodeBtn.disabled = false;
      }
    });
  });
}

elDevDisablePasscodeBtn.addEventListener('click', () => {
  elDevDisablePasscodeBtn.disabled = true;
  window.musicToDiscord.disableDevPasscode().then(() => refreshDevPanel());
});

// ---- Owner push notification ----
document.getElementById('owner-notif-send-btn').addEventListener('click', () => {
  const title = document.getElementById('owner-notif-title').value.trim();
  const body = document.getElementById('owner-notif-body').value.trim();
  const statusEl = document.getElementById('owner-notif-status');
  const btn = document.getElementById('owner-notif-send-btn');
  if (!title && !body) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  statusEl.textContent = '';
  window.musicToDiscord.sendOwnerNotification(title, body).then((ok) => {
    btn.disabled = false;
    btn.textContent = 'Send notification';
    if (ok) {
      statusEl.textContent = 'Sent';
      document.getElementById('owner-notif-body').value = '';
      document.getElementById('owner-notif-title').value = '';
    } else {
      statusEl.textContent = 'Failed';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  });
});

document.getElementById('owner-notif-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('owner-notif-send-btn').click();
});

elDevDeleteByNameBtn.addEventListener('click', () => {
  const name = elDevDeleteInput.value.trim();
  if (!name) return;
  elDevDeleteByNameBtn.disabled = true;
  window.musicToDiscord.devDeleteByUsername(name).then(() => {
    elDevDeleteByNameBtn.disabled = false;
    elDevDeleteInput.value = '';
    refreshDevPanel();
  });
});

elDevDeleteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') elDevDeleteByNameBtn.click();
});

async function loadBannedList() {
  const banned = await window.musicToDiscord.devListBanned().catch(() => []);
  if (!elDevBannedList) return;
  if (!banned || banned.length === 0) {
    elDevBannedList.textContent = 'No banned users.';
    return;
  }
  elDevBannedList.textContent = `Banned: ${banned.join(', ')}`;
}

elDevBanBtn.addEventListener('click', async () => {
  const name = elDevBanInput.value.trim();
  if (!name) return;
  elDevBanBtn.disabled = true;
  const ok = await window.musicToDiscord.devBanUsername(name).catch(() => false);
  elDevBanBtn.disabled = false;
  if (ok) {
    elDevBanInput.value = '';
    refreshDevPanel();
    loadBannedList();
  }
});

elDevUnbanBtn.addEventListener('click', async () => {
  const name = elDevBanInput.value.trim();
  if (!name) return;
  elDevUnbanBtn.disabled = true;
  await window.musicToDiscord.devUnbanUsername(name).catch(() => {});
  elDevUnbanBtn.disabled = false;
  elDevBanInput.value = '';
  loadBannedList();
});

elDevBanInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') elDevBanBtn.click();
});

// ---- Username setup overlay ----
elSetupInput.addEventListener('input', () => {
  elSetupSubmit.disabled = elSetupInput.value.trim().length === 0;
  elSetupInput.classList.remove('error');
  elSetupError.classList.remove('show');
});

elSetupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !elSetupSubmit.disabled) {
    elSetupSubmit.click();
  }
});

function showSetupError(message) {
  elSetupInput.classList.add('error');
  elSetupError.textContent = message;
  elSetupError.classList.add('show');
}

elSetupSubmit.addEventListener('click', () => {
  const name = elSetupInput.value.trim();
  if (!name) return;
  elSetupSubmit.disabled = true;
  elSetupSubmit.textContent = 'Saving…';
  elSetupInput.classList.remove('error');
  elSetupError.classList.remove('show');

  window.musicToDiscord.setUsername(name).then((result) => {
    elSetupSubmit.textContent = 'Save';
    if (result && result.ok) {
      currentUsername = name;
      elUsernameSub.textContent = name;
      elBtnRemoveUsername.style.display = 'block';
      elBtnDeleteStats.disabled = false;
      elSetupOverlay.classList.remove('show');
      return;
    }

    // Rejected -- figure out why and say something specific, then leave
    // the overlay open with the name still in the box so they can just
    // edit it and retry rather than starting over.
    elSetupSubmit.disabled = false;
    const reason = result && result.reason;
    if (reason === 'dev_mode_unlocked') {
      // Not a real username attempt -- close the overlay and reveal the
      // Dev tab instead of showing an error.
      elSetupInput.value = '';
      elSetupOverlay.classList.remove('show');
      elTabBtnDev.style.display = '';
      showTab('dev');
      return;
    }
    if (reason === 'owner_mode_unlocked' || reason === 'owner_mode_disabled') {
      elSetupInput.value = '';
      elSetupOverlay.classList.remove('show');
      const isOn = reason === 'owner_mode_unlocked';
      document.body.classList.toggle('owner-mode', isOn);
      if (isOn) {
        elTabBtnDev.style.display = '';
        showTab('dev');
      } else if (document.body.classList.contains('tab-dev')) {
        // Re-render the dev panel so the owner-only "disable passcode"
        // control disappears immediately rather than lingering until the
        // next 3s auto-refresh.
        refreshDevPanel();
      }
      return;
    }
    if (reason === 'easter_egg') {
      // A secret code, not a real name. Close the overlay and play the effect.
      elSetupInput.value = '';
      elSetupOverlay.classList.remove('show');
      triggerEasterEgg(result.egg);
      return;
    }
    if (reason === 'taken') {
      showSetupError("That name's already taken — try another.");
    } else if (reason === 'check_failed') {
      showSetupError("Couldn't check that name right now — check your connection and try again.");
    } else {
      showSetupError('Something went wrong saving that — try again.');
    }
  });
});

elSetupSkip.addEventListener('click', () => {
  // "Skip" just dismisses the overlay for this session -- it does NOT save
  // a username, so the prompt will reappear next launch. There's
  // intentionally no "don't ask again" here, since without a username
  // there's nothing for the leaderboard to track for this person anyway.
  elSetupOverlay.classList.remove('show');
});

elBtnChangeUsername.addEventListener('click', () => {
  elSetupInput.value = currentUsername || '';
  elSetupInput.classList.remove('error');
  elSetupError.classList.remove('show');
  elSetupSubmit.disabled = !currentUsername;
  elSetupSubmit.textContent = 'Save';
  elSetupOverlay.classList.add('show');
  elSetupInput.focus();
  elSetupInput.select();
});

elBtnRemoveUsername.addEventListener('click', () => {
  // This is the more drastic of the two destructive actions -- it doesn't
  // touch Firestore (the leaderboard entry and the name's claim both stay
  // exactly as they are), it just forgets the name locally so the setup
  // prompt reappears, as if this were a fresh install. A simple native
  // confirm() is enough friction here given how easy it is to undo (just
  // re-enter the same name) -- it stays claimed for this device either way.
  const confirmed = window.confirm(
    `Remove "${currentUsername}" from this app? Your leaderboard entry stays online — this just forgets the name on this device, and you'll be asked to set one again.`
  );
  if (!confirmed) return;
  window.musicToDiscord.clearUsername().then(() => {
    currentUsername = null;
    elUsernameSub.textContent = 'Not set';
    elBtnRemoveUsername.style.display = 'none';
    elBtnDeleteStats.disabled = true;
    elSetupInput.value = '';
    elSetupInput.classList.remove('error');
    elSetupError.classList.remove('show');
    elSetupSubmit.disabled = true;
    elSetupOverlay.classList.add('show');
    elSetupInput.focus();
  });
});

elBtnDeleteStats.addEventListener('click', () => {
  if (!currentUsername) return;
  const confirmed = window.confirm(
    "Reset this month's listening time to 0 on the leaderboard? This can't be undone."
  );
  if (!confirmed) return;
  elBtnDeleteStats.disabled = true;
  elBtnDeleteStats.textContent = 'Deleting…';
  window.musicToDiscord.deleteMyStats().then((ok) => {
    elBtnDeleteStats.disabled = false;
    elBtnDeleteStats.textContent = 'Delete';
    // No need to manually refresh here -- main.js pushes a
    // 'leaderboard-changed' event after a successful delete, which the
    // listener at the bottom of this file picks up and refreshes from.
  });
});

elBtnResetWrapped.addEventListener('click', () => {
  const confirmed = window.confirm(
    "Clear all your play history? This wipes your Wrapped, streaks, and recommendations on this device and can't be undone. Your leaderboard name and stats are not affected."
  );
  if (!confirmed) return;
  elBtnResetWrapped.disabled = true;
  elBtnResetWrapped.textContent = 'Resetting…';
  window.musicToDiscord.resetWrapped().then((ok) => {
    elBtnResetWrapped.disabled = false;
    elBtnResetWrapped.textContent = 'Reset';
    if (ok) {
      // Refresh the Wrapped view if it's currently open so it reflects the
      // now-empty history immediately rather than showing stale data.
      if (typeof loadWrapped === 'function') {
        try { loadWrapped(); } catch (e) {}
      }
    }
  });
});

// ---- Wire up controls ----
elToggleSync.addEventListener('click', () => window.musicToDiscord.togglePause());
elToggleSync.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    window.musicToDiscord.togglePause();
  }
});

// Tab textures toggle: flips body.textures-on and persists the choice.
function applyTextures(on) {
  document.body.classList.toggle('textures-on', !!on);
  elToggleTextures.classList.toggle('on', !!on);
  elToggleTextures.setAttribute('aria-checked', on ? 'true' : 'false');
}
function toggleTextures() {
  const on = !document.body.classList.contains('textures-on');
  applyTextures(on);
  window.musicToDiscord.setSetting('textures', on);
}
elToggleTextures.addEventListener('click', toggleTextures);
elToggleTextures.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleTextures();
  }
});

elBtnUpdate.addEventListener('click', () => {
  elBtnUpdate.textContent = 'Checking…';
  window.musicToDiscord.checkForUpdates();
  setTimeout(() => { elBtnUpdate.textContent = 'Check for updates'; }, 3000);
});

elBtnQuit.addEventListener('click', () => window.musicToDiscord.quitApp());
elBtnMin.addEventListener('click', () => window.close());
elBtnClose.addEventListener('click', () => window.musicToDiscord.quitApp());

// ---- Initial state + live updates ----
window.musicToDiscord.getState().then((state) => {
  render(state);
  // Show the one-time setup prompt only if no username has been saved yet
  // (state.username comes from main.js's loadUsername(), read on launch).
  if (!state.username) {
    elSetupOverlay.classList.add('show');
    elSetupInput.focus();
  }
});
window.musicToDiscord.onStateUpdate(render);

// Main process notifies us of leaderboard changes it made itself (e.g. a
// delete) so the board reflects it right away if it's currently open,
// rather than waiting for the next 30s auto-refresh.
window.musicToDiscord.onLeaderboardChanged(() => {
  if (document.body.classList.contains('tab-leaderboard')) {
    loadLeaderboard();
  }
});

// ---- Wrapped ----
function formatListeningTimeWrapped(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatHour(hour) {
  if (hour === 0) return '12am';
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return '12pm';
  return `${hour - 12}pm`;
}

function formatMonthLabel(monthKey) {
  const [year, mon] = monthKey.split('-').map(Number);
  return new Date(year, mon - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

async function loadWrapped() {
  const select = document.getElementById('wrapped-month-select');
  const emptyEl = document.getElementById('wrapped-empty');
  const contentEl = document.getElementById('wrapped-content');

  // Load available months into the dropdown
  const months = await window.musicToDiscord.getWrappedMonths();
  if (!months || months.length === 0) {
    select.style.display = 'none';
    emptyEl.style.display = 'block';
    contentEl.style.display = 'none';
    return;
  }

  select.style.display = '';
  if (select.options.length === 0 || select.dataset.loaded !== 'true') {
    select.innerHTML = months
      .map((m) => `<option value="${m}">${formatMonthLabel(m)}</option>`)
      .join('');
    select.dataset.loaded = 'true';
    select.onchange = () => renderWrapped(select.value);
  }

  renderWrapped(select.value || months[0]);
  loadStreaks();
  loadAchievements();
  loadThrowback();
  loadDailyGoal();
  loadPartyFeed();
  loadHistory();
}

async function renderWrapped(monthKey) {
  const emptyEl = document.getElementById('wrapped-empty');
  const contentEl = document.getElementById('wrapped-content');

  const data = await window.musicToDiscord.getWrapped(monthKey);

  if (!data) {
    emptyEl.style.display = 'block';
    contentEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  contentEl.style.display = 'flex';

  // Stats — count up the two numeric ones for a satisfying roll-in
  countUp(document.getElementById('wrapped-total-plays'), data.totalPlays);
  document.getElementById('wrapped-total-time').textContent = formatListeningTimeWrapped(data.totalSeconds);
  document.getElementById('wrapped-top-artist-short').textContent =
    data.topArtists[0] ? data.topArtists[0].artist.split(' ')[0] : '—';
  document.getElementById('wrapped-busiest-hour').textContent = formatHour(data.busiestHour);

  // Top songs
  const songsEl = document.getElementById('wrapped-top-songs');
  songsEl.innerHTML = data.topSongs.map((s, i) => `
    <div class="wrapped-rank-row row-animate" style="animation-delay:${Math.min(i * 0.06, 0.5)}s">
      <div class="wrapped-rank-num">${i + 1}</div>
      <div class="wrapped-rank-info">
        <div class="wrapped-rank-name">${esc(s.name)}</div>
        <div class="wrapped-rank-sub">${esc(s.artist)}</div>
      </div>
      <div class="wrapped-rank-count">${s.count}×</div>
    </div>
  `).join('');

  // Top artists
  const artistsEl = document.getElementById('wrapped-top-artists');
  artistsEl.innerHTML = data.topArtists.map((a, i) => `
    <div class="wrapped-rank-row row-animate" style="animation-delay:${Math.min(i * 0.06, 0.5)}s">
      <div class="wrapped-rank-num">${i + 1}</div>
      <div class="wrapped-rank-info">
        <div class="wrapped-rank-name">${esc(a.artist || 'Unknown')}</div>
      </div>
      <div class="wrapped-rank-count">${a.count}×</div>
    </div>
  `).join('');

  // Fun facts
  const facts = [];
  if (data.topSongs[0]) {
    facts.push(`You played <span>${esc(data.topSongs[0].name)}</span> ${data.topSongs[0].count} times — your most-played song.`);
  }
  if (data.mostActiveDayLabel) {
    facts.push(`Your most active day was <span>${data.mostActiveDayLabel}</span> with ${data.mostActiveDayCount} songs.`);
  }
  facts.push(`You listened most at <span>${formatHour(data.busiestHour)}</span>.`);

  document.getElementById('wrapped-fun-facts').innerHTML = facts
    .map((f) => `<div style="margin-bottom:10px">${f}</div>`)
    .join('');
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---- Update banner ----
elUpdateBannerBtn.addEventListener('click', () => {
  window.musicToDiscord.installUpdate();
});

window.musicToDiscord.onUpdateStatus((info) => {
  if (info.status === 'downloading') {
    elUpdateBanner.classList.add('show');
    elUpdateBannerText.textContent = info.version
      ? `Downloading v${info.version}…`
      : 'Downloading update…';
    elUpdateBannerBtn.disabled = true;
  } else if (info.status === 'ready') {
    elUpdateBanner.classList.add('show');
    elUpdateBannerText.textContent = info.version
      ? `v${info.version} ready to install`
      : 'Update ready to install';
    elUpdateBannerBtn.disabled = false;
  } else if (info.status === 'idle' || info.status === 'error') {
    elUpdateBanner.classList.remove('show');
  }
});

// ---- Streaks (loaded as part of Wrapped) ----
async function loadStreaks() {
  const data = await window.musicToDiscord.getStreaks();
  if (!data) return;
  document.getElementById('streak-current').textContent =
    data.current > 0 ? `${data.current}d` : '0';
  document.getElementById('streak-longest').textContent =
    data.longest > 0 ? `${data.longest}d` : '0';
  document.getElementById('streak-today').textContent = data.todayCount;
}

// ---- Daily listening goal (loaded as part of Wrapped) ----
let goalInputWired = false;
let goalCelebrated = false;

// ---- Listening party feed (loaded as part of Wrapped) ----
async function loadPartyFeed() {
  const feed = document.getElementById('party-feed');
  if (!feed) return;
  try {
    const data = await window.musicToDiscord.getListeningParty();
    if (!data || data.total === 0) {
      feed.innerHTML = '<div class="party-empty">No one else is listening right now.</div>';
      return;
    }
    // Same-song listeners first
    const sorted = [...data.listeners].sort((a, b) => (b.sameSong ? 1 : 0) - (a.sameSong ? 1 : 0));
    feed.innerHTML = sorted.map((l) => `
      <div class="party-feed-row ${l.sameSong ? 'same-song' : ''}">
        <span class="party-feed-dot"></span>
        <div class="party-feed-info">
          <div class="party-feed-user">${esc(l.username)}${l.sameSong ? ' — same song!' : ''}</div>
          <div class="party-feed-song">${esc(l.song)}${l.artist ? ' — ' + esc(l.artist) : ''}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    feed.innerHTML = '<div class="party-empty">Listening party unavailable.</div>';
  }
}

// ---- Recent history timeline + search (loaded as part of Wrapped) ----
let historySearchWired = false;
function formatHistoryTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
async function loadHistory(query) {
  const list = document.getElementById('history-list');
  if (!list) return;
  const entries = await window.musicToDiscord.getHistory(query || '');
  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="history-empty">No plays found.</div>';
  } else {
    list.innerHTML = entries.map((e) => `
      <div class="history-row">
        <span class="history-name">${esc(e.name || 'Unknown')}</span>
        <span class="history-artist">${esc(e.artist || '')}</span>
        <span class="history-time">${formatHistoryTime(e.timestamp)}</span>
      </div>
    `).join('');
  }
  // Wire the search box once.
  if (!historySearchWired) {
    historySearchWired = true;
    const search = document.getElementById('history-search');
    let debounce = null;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadHistory(search.value), 200);
    });
  }
}
async function loadDailyGoal() {
  const data = await window.musicToDiscord.getDailyGoal();
  if (!data) return;
  const { todaySeconds, goalMinutes } = data;
  const goalSeconds = goalMinutes * 60;
  const pct = goalSeconds > 0 ? Math.min(todaySeconds / goalSeconds, 1) : 0;

  const ring = document.getElementById('goal-ring-fill');
  const circumference = 326.7;
  ring.style.strokeDashoffset = String(circumference * (1 - pct));

  document.getElementById('goal-ring-pct').textContent = `${Math.round(pct * 100)}%`;

  const todayMin = Math.round(todaySeconds / 60);
  const statusEl = document.getElementById('goal-status');
  if (pct >= 1) {
    statusEl.textContent = `Goal reached! ${todayMin}m today`;
    // Celebrate the first time we observe the goal hit in this session.
    if (!goalCelebrated) {
      goalCelebrated = true;
      celebrate();
    }
  } else {
    statusEl.textContent = `${todayMin}m of ${goalMinutes}m`;
  }

  const input = document.getElementById('goal-input');
  input.value = goalMinutes;
  // Wire the input once: saving a new goal persists it and re-renders the ring.
  if (!goalInputWired) {
    goalInputWired = true;
    input.addEventListener('change', () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 5) val = 5;
      if (val > 600) val = 600;
      input.value = val;
      window.musicToDiscord.setSetting('dailyGoalMinutes', val);
      loadDailyGoal();
    });
  }
}

// ---- Achievements (loaded as part of Wrapped) ----
// Remembers which badges were unlocked last render so newly-earned ones can
// pop in with an animation rather than just appearing.
let knownUnlockedBadges = new Set();

async function loadAchievements() {
  const data = await window.musicToDiscord.getAchievements();
  if (!data) return;
  const grid = document.getElementById('achievements-grid');
  const progress = document.getElementById('ach-progress');
  progress.textContent = `${data.unlockedCount}/${data.total}`;

  grid.innerHTML = data.badges.map((b) => {
    const isNew = b.unlocked && !knownUnlockedBadges.has(b.id);
    const cls = `ach-badge ${b.unlocked ? 'unlocked' : 'locked'}${isNew ? ' just-unlocked' : ''}`;
    // title attribute gives a native tooltip with the description
    const tip = b.unlocked ? `${b.title} — ${b.desc}` : `Locked: ${b.desc}`;
    // Monogram from the badge title (first letter), shown in a styled circle
    // instead of an emoji for a cleaner, more professional look. Locked badges
    // show a dash.
    const mono = b.unlocked ? (b.title.trim()[0] || '?').toUpperCase() : '–';
    return `
      <div class="${cls}" title="${esc(tip)}">
        <div class="ach-badge-mono">${esc(mono)}</div>
        <div class="ach-badge-title">${esc(b.title)}</div>
      </div>
    `;
  }).join('');

  knownUnlockedBadges = new Set(data.badges.filter((b) => b.unlocked).map((b) => b.id));
}

// ---- "On this day" throwback (loaded as part of Wrapped) ----
async function loadThrowback() {
  const card = document.getElementById('throwback-card');
  const content = document.getElementById('throwback-content');
  const data = await window.musicToDiscord.getThrowback();
  if (!data) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const songs = data.topSongs.map((s) => `
    <div class="tb-song">
      <span>${esc(s.name)}</span>
      <span style="color:var(--text-dim)">${esc(s.artist)}</span>
      <span class="tb-count">${s.count}×</span>
    </div>
  `).join('');
  content.innerHTML = `
    <div class="tb-label">${esc(data.label)}</div>
    <div class="tb-date">${esc(data.dateStr)} · ${data.totalPlays} song${data.totalPlays === 1 ? '' : 's'} played</div>
    ${songs}
  `;
}

// Refresh achievements live when the main process unlocks one mid-session,
// so the badge pops in even if the Wrapped tab is already open.
window.musicToDiscord.onAchievementsChanged(() => {
  // A new badge unlocked mid-session -- celebrate, and refresh the grid if
  // the Wrapped tab is open.
  celebrate();
  if (document.body.classList.contains('tab-wrapped')) {
    loadAchievements();
  }
});

// ---- Share card ----
async function loadShareCard() {
  const data = await window.musicToDiscord.getShareCard();
  const emptyEl = document.getElementById('share-empty');
  const cardEl = document.getElementById('share-card');
  const copyBtn = document.getElementById('share-copy-btn');

  if (!data) {
    emptyEl.style.display = 'block';
    cardEl.style.display = 'none';
    copyBtn.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  cardEl.style.display = 'flex';
  copyBtn.style.display = '';

  document.getElementById('share-card-label').textContent =
    data.state === 'paused' ? 'Paused' : 'Now Playing';
  document.getElementById('share-card-name').textContent = data.name;
  document.getElementById('share-card-artist').textContent = data.artist;
  document.getElementById('share-card-album').textContent = data.album || '';

  const artImg = document.getElementById('share-card-art-img');
  const artFallback = document.getElementById('share-card-art-fallback');
  if (data.artworkDataUrl) {
    artImg.src = data.artworkDataUrl;
    artImg.style.display = 'block';
    artFallback.style.display = 'none';
  } else {
    artImg.style.display = 'none';
    artFallback.style.display = '';
  }
}

document.getElementById('share-copy-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('share-copy-status');
  const btn = document.getElementById('share-copy-btn');
  const cardEl = document.getElementById('share-card');

  btn.disabled = true;
  btn.textContent = 'Copying…';

  try {
    // Use the Clipboard API to write text — a clean "Now Playing" summary
    // since image clipboard from HTML requires canvas which isn't worth
    // the complexity here.
    const name = document.getElementById('share-card-name').textContent;
    const artist = document.getElementById('share-card-artist').textContent;
    const album = document.getElementById('share-card-album').textContent;
    const albumPart = album ? ` (${album})` : '';
    const text = `Listening to: ${name} by ${artist}${albumPart} — via MusicToDiscord`;
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    statusEl.textContent = 'Paste anywhere to share';
  } catch (e) {
    btn.textContent = 'Failed';
    statusEl.textContent = 'Could not access clipboard';
  }

  setTimeout(() => {
    btn.textContent = 'Copy as text';
    btn.disabled = false;
    statusEl.textContent = '';
  }, 3000);
});

// ---- Recommendations ----
async function loadRecommendations() {
  const recs = await window.musicToDiscord.getRecommendations();
  const listEl = document.getElementById('recs-list');
  const emptyEl = document.getElementById('recs-empty');

  if (!recs || recs.length === 0) {
    emptyEl.style.display = 'block';
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = recs.map(r => `
    <div class="rec-row">
      <div class="rec-icon">&#9834;</div>
      <div class="rec-info">
        <div class="rec-name">${esc(r.name)}</div>
        <div class="rec-artist">${esc(r.artist)}</div>
      </div>
    </div>
  `).join('');
}

// ---- Background customizer ----
const BG_PRESETS = [
  { label: 'Default dark',   value: '#0F0F14' },
  { label: 'Deep navy',      value: '#0a0e1a' },
  { label: 'Dark green',     value: '#0a1a0f' },
  { label: 'Dark purple',    value: '#150a1a' },
  { label: 'Dark red',       value: '#1a0a0a' },
  { label: 'Indigo gradient',value: 'linear-gradient(135deg, #0f0f14 0%, #1a1428 100%)' },
  { label: 'Ocean',          value: 'linear-gradient(135deg, #0a0e1a 0%, #0a1a2a 100%)' },
  { label: 'Midnight',       value: 'linear-gradient(160deg, #0d0d0d 0%, #1a1a2e 100%)' },
  { label: 'Sunset',         value: 'linear-gradient(135deg, #1a0a0a 0%, #1a0a18 100%)' },
  { label: 'Forest',         value: 'linear-gradient(135deg, #0a1a0f 0%, #0d1a1a 100%)' },
];

const DEFAULT_BG = '#0F0F14';
let currentBg = DEFAULT_BG;

function applyBackground(value) {
  if (!value) value = DEFAULT_BG;
  currentBg = value;
  // If it looks like a URL or data URI, use as background-image
  if (value.startsWith('url(') || value.startsWith('data:') || /\.(png|jpg|jpeg|gif|webp)$/i.test(value)) {
    document.body.style.background = `url("${value.replace(/^url\(["']?|["']?\)$/g, '')}") center/cover no-repeat fixed`;
  } else {
    document.body.style.background = value;
  }
  // Update active state on presets
  document.querySelectorAll('.bg-preset').forEach(el => {
    el.classList.toggle('active', el.dataset.value === value);
  });
  // Update input field
  const input = document.getElementById('bg-custom-input');
  if (input && !value.startsWith('data:')) input.value = value === DEFAULT_BG ? '' : value;
}

function saveBg(value) {
  applyBackground(value);
  window.musicToDiscord.setSetting('background', value);
}

// Build preset swatches
function buildPresets() {
  const container = document.getElementById('bg-presets');
  if (!container) return;
  container.innerHTML = BG_PRESETS.map(p => {
    const isGradient = p.value.includes('gradient');
    const style = isGradient ? `background: ${p.value}` : `background: ${p.value}`;
    return `<div class="bg-preset" data-value="${p.value}" style="${style}" title="${p.label}"></div>`;
  }).join('');

  container.querySelectorAll('.bg-preset').forEach(el => {
    el.addEventListener('click', () => saveBg(el.dataset.value));
  });
}

buildPresets();

// Custom input
const bgInput = document.getElementById('bg-custom-input');
if (bgInput) {
  bgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = bgInput.value.trim();
      if (val) saveBg(val);
    }
  });
  bgInput.addEventListener('blur', () => {
    const val = bgInput.value.trim();
    if (val) saveBg(val);
  });
}

// Image file picker
const bgImageBtn = document.getElementById('bg-image-btn');
const bgFileInput = document.getElementById('bg-file-input');
if (bgImageBtn && bgFileInput) {
  bgImageBtn.addEventListener('click', () => bgFileInput.click());
  bgFileInput.addEventListener('change', () => {
    const file = bgFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => saveBg(e.target.result);
    reader.readAsDataURL(file);
  });
}

// Reset button
const bgResetBtn = document.getElementById('bg-reset-btn');
if (bgResetBtn) {
  bgResetBtn.addEventListener('click', () => {
    if (bgInput) bgInput.value = '';
    saveBg(DEFAULT_BG);
  });
}

// Load saved background on startup
window.musicToDiscord.getSettings().then(settings => {
  if (settings && settings.background) {
    applyBackground(settings.background);
  }
  // Restore the tab-textures preference (defaults off).
  applyTextures(!!(settings && settings.textures));
  // Restore custom accent color if set.
  if (settings && settings.accentColor) {
    applyAccent(settings.accentColor);
    const ai = document.getElementById('accent-input');
    if (ai) ai.value = settings.accentColor;
  }
  // Restore clock style (default analog).
  const clockStyle = (settings && settings.clockStyle) || 'analog';
  applyClockStyle(clockStyle);
  const cs = document.getElementById('clock-style-select');
  if (cs) cs.value = clockStyle;

  // Random theme on launch: if enabled, apply a random palette now.
  const randomOn = !!(settings && settings.randomThemeOnLaunch);
  applyRandomThemeToggle(randomOn);
  if (randomOn && typeof applyRandomLaunchTheme === 'function') {
    applyRandomLaunchTheme();
  }
});

// Applies a random accent palette (used by "random theme on launch").
function applyRandomLaunchTheme() {
  const palettes = [
    { accent: '#FF6FB5', bg: '#1a0f1a' }, { accent: '#C2454B', bg: '#1a0d0e' },
    { accent: '#7CC4FF', bg: '#0d1320' }, { accent: '#E0B84C', bg: '#1a1608' },
    { accent: '#5FE0A8', bg: '#0c1a14' }, { accent: '#A77CFF', bg: '#140d1f' },
    { accent: '#FF8A3D', bg: '#1f1109' }, { accent: '#FF4D6D', bg: '#1c0a10' },
  ];
  const p = palettes[Math.floor(Math.random() * palettes.length)];
  const root = document.documentElement;
  root.style.setProperty('--indigo', p.accent);
  root.style.setProperty('--sky', p.accent);
  root.style.setProperty('--dyn-bg', p.bg);
  root.style.setProperty('--dyn-bg-raised', p.bg.replace(/^#/, '#1'));
  document.body.classList.add('dynamic-theme');
}

// Applies a clock face style by toggling body classes.
function applyClockStyle(style) {
  document.body.classList.remove('clock-digital', 'clock-minimal');
  if (style === 'digital') document.body.classList.add('clock-digital');
  else if (style === 'minimal') document.body.classList.add('clock-minimal');
}
(function initClockStylePicker() {
  const select = document.getElementById('clock-style-select');
  if (!select) return;
  select.addEventListener('change', () => {
    applyClockStyle(select.value);
    window.musicToDiscord.setSetting('clockStyle', select.value);
  });
})();

// Export listening data buttons.
(function initExport() {
  function doExport(format, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    window.musicToDiscord.exportHistory(format).then((res) => {
      btn.disabled = false;
      if (res && res.ok) {
        btn.textContent = 'Saved!';
      } else if (res && res.reason === 'empty') {
        btn.textContent = 'No data';
      } else if (res && res.reason === 'canceled') {
        btn.textContent = original;
      } else {
        btn.textContent = 'Failed';
      }
      if (btn.textContent !== original) {
        setTimeout(() => { btn.textContent = original; }, 2000);
      }
    });
  }
  const jbtn = document.getElementById('export-json-btn');
  const cbtn = document.getElementById('export-csv-btn');
  if (jbtn) jbtn.addEventListener('click', () => doExport('json', jbtn));
  if (cbtn) cbtn.addEventListener('click', () => doExport('csv', cbtn));
})();

// Random theme on launch toggle.
const elToggleRandomTheme = document.getElementById('toggle-random-theme');
function applyRandomThemeToggle(on) {
  if (elToggleRandomTheme) {
    elToggleRandomTheme.classList.toggle('on', !!on);
    elToggleRandomTheme.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}
(function initRandomThemeToggle() {
  if (!elToggleRandomTheme) return;
  function toggle() {
    const on = !elToggleRandomTheme.classList.contains('on');
    applyRandomThemeToggle(on);
    window.musicToDiscord.setSetting('randomThemeOnLaunch', on);
  }
  elToggleRandomTheme.addEventListener('click', toggle);
  elToggleRandomTheme.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
})();

// Applies a custom accent color by overriding the --indigo/--sky variables.
// Passing null clears the override (back to theme default).
function applyAccent(color) {
  const root = document.documentElement;
  if (color) {
    root.style.setProperty('--indigo', color);
    root.style.setProperty('--sky', color);
  } else {
    root.style.removeProperty('--indigo');
    root.style.removeProperty('--sky');
  }
}

// Wire the accent picker controls.
(function initAccentPicker() {
  const input = document.getElementById('accent-input');
  const resetBtn = document.getElementById('accent-reset-btn');
  if (!input) return;
  input.addEventListener('input', () => {
    applyAccent(input.value);
    window.musicToDiscord.setSetting('accentColor', input.value);
  });
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      applyAccent(null);
      window.musicToDiscord.setSetting('accentColor', null);
      input.value = '#5865F2';
    });
  }
})();

// Live updates from other windows/instances
window.musicToDiscord.onSettingChanged(({ key, value }) => {
  if (key === 'background') applyBackground(value);
  if (key === 'textures') applyTextures(!!value);
});

// ================================================================
// WIDE LAYOUT MODE
// ================================================================

// ================================================================
// ANALOG CLOCK
// ================================================================
// Draws the tick marks once, then sweeps the hands every second. The second
// hand moves smoothly; hour/minute update with it. Uses requestAnimationFrame
// only while the window is visible to avoid wasting cycles in the tray.
(function initClock() {
  const ticksGroup = document.getElementById('clock-ticks');
  const handHour = document.getElementById('hand-hour');
  const handMinute = document.getElementById('hand-minute');
  const handSecond = document.getElementById('hand-second');
  const digital = document.getElementById('clock-digital');
  if (!ticksGroup || !handHour) return;

  // Build 12 tick marks around the face.
  const SVGNS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    // Skip minor ticks for a cleaner look; keep only the 12 majors.
    if (!major) continue;
    const angle = (i / 60) * Math.PI * 2;
    const inner = major ? 78 : 84;
    const outer = 88;
    const x1 = 100 + Math.sin(angle) * inner;
    const y1 = 100 - Math.cos(angle) * inner;
    const x2 = 100 + Math.sin(angle) * outer;
    const y2 = 100 - Math.cos(angle) * outer;
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', x1.toFixed(1));
    line.setAttribute('y1', y1.toFixed(1));
    line.setAttribute('x2', x2.toFixed(1));
    line.setAttribute('y2', y2.toFixed(1));
    line.setAttribute('class', 'clock-tick major');
    ticksGroup.appendChild(line);
  }

  function tick() {
    const now = new Date();
    const ms = now.getMilliseconds();
    const s = now.getSeconds() + ms / 1000;
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;

    const secAngle = s * 6;        // 360/60
    const minAngle = m * 6;
    const hourAngle = h * 30;      // 360/12

    handSecond.setAttribute('transform', `rotate(${secAngle} 100 100)`);
    handMinute.setAttribute('transform', `rotate(${minAngle} 100 100)`);
    handHour.setAttribute('transform', `rotate(${hourAngle} 100 100)`);

    // Digital readout under the clock (12-hour with AM/PM).
    let hh = now.getHours();
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12 || 12;
    const mm = String(now.getMinutes()).padStart(2, '0');
    digital.textContent = `${hh}:${mm} ${ampm}`;

    // Big digital-mode clock (separate element).
    const bigDigital = document.getElementById('digital-clock');
    if (bigDigital) {
      const ampmSpan = document.getElementById('digital-clock-ampm');
      bigDigital.firstChild.textContent = `${hh}:${mm}`;
      if (ampmSpan) ampmSpan.textContent = ampm;
    }
  }

  let rafId = null;
  function loop() {
    tick();
    rafId = requestAnimationFrame(loop);
  }

  // Pause the smooth animation when the window is hidden (tray), resume on show.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (!rafId) {
      loop();
    }
  });

  loop();
})();

// ================================================================
// FUN BUTTONS (Now Playing)
// ================================================================
(function initFunButtons() {
  const output = document.getElementById('fun-output');
  const btnQuote = document.getElementById('fun-btn-quote');
  const btnShuffle = document.getElementById('fun-btn-shuffle');
  const btnArt = document.getElementById('fun-btn-art');
  if (!output) return;

  // --- Ye-isms: ORIGINAL confident one-liners written in a braggadocious
  // style. These are NOT real Kanye quotes or lyrics -- they're original text
  // so there's no copyright issue. ---
  const YEISMS = [
    "I'm not here to fit in. I'm here to stand out.",
    "Doubt me once, watch me do it twice.",
    "Greatness isn't given. It's taken.",
    "They laughed at the dream. Now they stream it.",
    "I don't chase trends. I leave footprints.",
    "Average was never an option.",
    "The vision was clear before the world could see it.",
    "I turned the noise into a symphony.",
    "Built different, wired louder.",
    "Confidence is just talent that showed up early.",
    "I don't follow the wave. I am the tide.",
    "Every 'no' was just a remix waiting to happen.",
    "Legends don't ask for permission.",
    "I speak in futures the present can't pronounce.",
    "Ordinary minds make ordinary noise. I make anthems.",
    "The ceiling was just a floor I hadn't reached yet.",
    "I bet on myself when the odds laughed back.",
    "Make it loud enough and the doubters become fans.",
  ];

  let lastQuoteIdx = -1;
  function showQuote() {
    let idx;
    do { idx = Math.floor(Math.random() * YEISMS.length); }
    while (idx === lastQuoteIdx && YEISMS.length > 1);
    lastQuoteIdx = idx;
    output.innerHTML = `<div class="fun-quote">"${esc(YEISMS[idx])}"</div>`;
  }

  // --- Color shuffle: era-INSPIRED palettes (no album art, just colors).
  // Applies as the dynamic theme so the whole UI + clock shift. ---
  const PALETTES = [
    { name: 'Sunrise', accent: '#FF6FB5', bg: '#1a0f1a' },
    { name: 'Maroon',  accent: '#C2454B', bg: '#1a0d0e' },
    { name: 'Sky',     accent: '#7CC4FF', bg: '#0d1320' },
    { name: 'Gold',    accent: '#E0B84C', bg: '#1a1608' },
    { name: 'Mint',    accent: '#5FE0A8', bg: '#0c1a14' },
    { name: 'Violet',  accent: '#A77CFF', bg: '#140d1f' },
    { name: 'Ember',   accent: '#FF8A3D', bg: '#1f1109' },
    { name: 'Crimson', accent: '#FF4D6D', bg: '#1c0a10' },
  ];
  let lastPaletteIdx = -1;
  function shufflePalette() {
    let idx;
    do { idx = Math.floor(Math.random() * PALETTES.length); }
    while (idx === lastPaletteIdx && PALETTES.length > 1);
    lastPaletteIdx = idx;
    const p = PALETTES[idx];
    const root = document.documentElement;
    root.style.setProperty('--indigo', p.accent);
    root.style.setProperty('--sky', p.accent);
    root.style.setProperty('--dyn-bg', p.bg);
    // raised bg = slightly lighter than bg
    root.style.setProperty('--dyn-bg-raised', p.bg.replace(/^#/, '#1'));
    document.body.classList.add('dynamic-theme');
    output.innerHTML = `<div class="fun-quote">${esc(p.name)}</div>`;
  }

  // --- Generative art: random original abstract burst drawn on a canvas. ---
  function makeArt() {
    output.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'fun-art-canvas';
    canvas.width = 280;
    canvas.height = 140;
    output.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // Random background gradient
    const hue1 = Math.floor(Math.random() * 360);
    const hue2 = (hue1 + 60 + Math.floor(Math.random() * 180)) % 360;
    const grad = ctx.createLinearGradient(0, 0, 280, 140);
    grad.addColorStop(0, `hsl(${hue1}, 70%, 18%)`);
    grad.addColorStop(1, `hsl(${hue2}, 70%, 12%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 280, 140);

    // Random circles and lines
    const shapeCount = 8 + Math.floor(Math.random() * 10);
    for (let i = 0; i < shapeCount; i++) {
      const hue = (hue1 + Math.random() * 120) % 360;
      ctx.fillStyle = `hsla(${hue}, 80%, ${50 + Math.random() * 30}%, ${0.3 + Math.random() * 0.5})`;
      ctx.strokeStyle = ctx.fillStyle;
      if (Math.random() < 0.6) {
        ctx.beginPath();
        ctx.arc(Math.random() * 280, Math.random() * 140, 4 + Math.random() * 30, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 1 + Math.random() * 4;
        ctx.beginPath();
        ctx.moveTo(Math.random() * 280, Math.random() * 140);
        ctx.lineTo(Math.random() * 280, Math.random() * 140);
        ctx.stroke();
      }
    }
  }

  btnQuote.addEventListener('click', showQuote);
  btnShuffle.addEventListener('click', shufflePalette);
  btnArt.addEventListener('click', makeArt);

  // "Daily" -> a theme-of-the-day: deterministic from today's date, so it's
  // the same all day but changes each day. Applies a palette + shows the day's
  // Ye-ism paired with it.
  const btnDaily = document.getElementById('fun-btn-daily');
  if (btnDaily) {
    btnDaily.addEventListener('click', () => {
      const now = new Date();
      // Day-of-year as a stable seed for today.
      const start = new Date(now.getFullYear(), 0, 0);
      const dayOfYear = Math.floor((now - start) / 86400000);
      const p = PALETTES[dayOfYear % PALETTES.length];
      const quote = YEISMS[dayOfYear % YEISMS.length];
      const root = document.documentElement;
      root.style.setProperty('--indigo', p.accent);
      root.style.setProperty('--sky', p.accent);
      root.style.setProperty('--dyn-bg', p.bg);
      root.style.setProperty('--dyn-bg-raised', p.bg.replace(/^#/, '#1'));
      document.body.classList.add('dynamic-theme');
      output.innerHTML = `<div class="fun-quote">Today's vibe: ${esc(p.name)}<br><span style="font-size:13px;opacity:0.85">"${esc(quote)}"</span></div>`;
    });
  }
})();

// ================================================================
// MINI VISUALIZER
// ================================================================
// Builds a strip of bars with randomized animation timing so they bounce
// organically (like a real visualizer) while music plays. We don't have the
// raw audio stream -- this is a stylized fake driven purely by CSS animation,
// shown only while body.is-playing is set.
(function initVisualizer() {
  const viz = document.getElementById('visualizer');
  if (!viz) return;
  const BAR_COUNT = 28;
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('span');
    // Randomize each bar's speed and phase so they don't move in lockstep.
    const dur = (0.6 + Math.random() * 0.9).toFixed(2);
    const delay = (Math.random() * -1.2).toFixed(2);
    bar.style.animationDuration = `${dur}s`;
    bar.style.animationDelay = `${delay}s`;
    viz.appendChild(bar);
  }
})();

// ================================================================
// LISTENING PARTY
// ================================================================
// Polls Firestore presence every 20s and shows how many others are listening
// right now, highlighting when someone's on the same song as you. Fails
// silently (just hides) when Firestore is unreachable, e.g. on a school
// network that blocks it.
(function initListeningParty() {
  const el = document.getElementById('listening-party');
  if (!el) return;

  async function refresh() {
    try {
      const data = await window.musicToDiscord.getListeningParty();
      if (!data || data.unavailable || data.total === 0) {
        el.style.display = 'none';
        return;
      }
      const sameSong = data.listeners.filter((l) => l.sameSong);
      el.style.display = 'flex';
      if (sameSong.length > 0) {
        el.classList.add('same-song');
        const names = sameSong.slice(0, 2).map((l) => l.username).join(', ');
        const extra = sameSong.length > 2 ? ` +${sameSong.length - 2} more` : '';
        el.innerHTML = `<span class="party-dot"></span> Listening with ${esc(names)}${extra} — same song!`;
      } else {
        el.classList.remove('same-song');
        el.innerHTML = `<span class="party-dot"></span> ${data.total} ${data.total === 1 ? 'other is' : 'others are'} listening right now`;
      }
    } catch (e) {
      el.style.display = 'none';
    }
  }

  refresh();
  setInterval(refresh, 20000);
})();

// ================================================================
// CELEBRATION EFFECTS (confetti)
// ================================================================
// Lightweight canvas confetti burst -- no library. Used when an achievement
// unlocks or the daily goal is hit. Respects reduced motion.
function celebrate() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const colors = ['#5865F2', '#FF6FB5', '#E0B84C', '#5FE0A8', '#A77CFF', '#FF8A3D'];
  const pieces = [];
  const COUNT = 90;
  for (let i = 0; i < COUNT; i++) {
    pieces.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 120,
      y: canvas.height / 3,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -10 - 4,
      size: 5 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.3,
      life: 1,
    });
  }

  const gravity = 0.35;
  let frames = 0;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of pieces) {
      p.vy += gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.life -= 0.008;
      if (p.life > 0 && p.y < canvas.height + 20) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    frames++;
    if (alive && frames < 240) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  }
  tick();
}

// ================================================================
// KEYBOARD SHORTCUTS
// ================================================================
// Quick navigation without the mouse:
//   1-6  -> switch tabs (Now Playing / Leaderboard / Wrapped / Share / For You / Settings)
//   M    -> toggle mini always-on-top mode
//   /    -> focus the history search (when on Wrapped)
// Ignored while typing in an input so we don't hijack the search box etc.
(function initShortcuts() {
  const TAB_KEYS = {
    '1': 'now-playing',
    '2': 'leaderboard',
    '3': 'wrapped',
    '4': 'share',
    '5': 'recs',
    '6': 'settings',
  };
  document.addEventListener('keydown', (e) => {
    // Don't intercept when the user is typing in a field.
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (TAB_KEYS[e.key]) {
      e.preventDefault();
      showTab(TAB_KEYS[e.key]);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMiniMode();
    } else if (e.key === '/') {
      // Jump to Wrapped + focus search
      e.preventDefault();
      showTab('wrapped');
      setTimeout(() => {
        const s = document.getElementById('history-search');
        if (s) s.focus();
      }, 100);
    }
  });
})();

// ================================================================
// MINI MODE
// ================================================================
let miniModeOn = false;
function toggleMiniMode() {
  miniModeOn = !miniModeOn;
  document.body.classList.toggle('mini-mode', miniModeOn);
  window.musicToDiscord.toggleMiniMode(miniModeOn);
}
(function wireMiniButton() {
  const btn = document.getElementById('btn-mini');
  if (btn) btn.addEventListener('click', toggleMiniMode);
})();

// ================================================================
// SLEEP TIMER
// ================================================================
(function initSleepTimer() {
  const select = document.getElementById('sleep-select');
  const sub = document.getElementById('sleep-sub');
  if (!select) return;
  select.addEventListener('change', () => {
    const minutes = parseInt(select.value, 10);
    window.musicToDiscord.setSleepTimer(minutes);
    if (minutes > 0) {
      sub.textContent = `Sync will pause in ${minutes < 60 ? minutes + ' min' : (minutes / 60) + ' hour' + (minutes > 60 ? 's' : '')}`;
    } else {
      sub.textContent = 'Auto-pause Discord sync after a set time';
    }
  });
  // When the timer fires, reset the dropdown and note it.
  window.musicToDiscord.onSleepTimerFired(() => {
    select.value = '0';
    sub.textContent = 'Sleep timer paused your sync. Toggle sync back on anytime.';
  });
})();

// ================================================================
// EASTER EGGS
// ================================================================
// Triggered by typing secret codes into the username box (handled in main.js,
// which returns reason 'easter_egg' + an egg id). Each is purely cosmetic and
// temporary -- nothing is saved. Codes (case-insensitive):
//   CONFETTI / PARTY -> confetti burst
//   RAINBOW          -> cycle the accent through rainbow colors briefly
//   MATRIX           -> green digital-rain overlay
//   GOLDEN           -> flash a gold theme
//   VAPOR            -> vaporwave pink/cyan theme flash
//   808S             -> moody dark-blue theme flash ("heartbreak")
//   YEEZY            -> sandy/beige theme flash
//   BARKING          -> a row of paw prints floats up
//   SECRET           -> reveals the full list of codes as a toast
function triggerEasterEgg(egg) {
  switch (egg) {
    case 'confetti':
      celebrate();
      eggToast('🎉 Party mode!');
      break;
    case 'rainbow':
      rainbowAccent();
      eggToast('🌈 Taste the rainbow');
      break;
    case 'matrix':
      matrixRain();
      eggToast('Wake up...');
      break;
    case 'golden':
      themeFlash('#E0B84C', '#1a1608', 'Golden hour ✨');
      break;
    case 'vapor':
      themeFlash('#FF6FB5', '#1a0f1f', 'A E S T H E T I C');
      break;
    case 'heartbreak':
      themeFlash('#4A6FA5', '#0b1018', '808s & Heartbreak');
      break;
    case 'yeezy':
      themeFlash('#C2B280', '#1a1610', 'Yeezy season');
      break;
    case 'barking':
      pawPrints();
      eggToast('🐾 Woof');
      break;
    case 'secret':
      eggToast('Codes: CONFETTI · RAINBOW · MATRIX · GOLDEN · VAPOR · 808S · YEEZY · BARKING · SNOW · FIRE · DISCO · STARS · GLITCH · ZEN', 7000);
      break;
    case 'snow':
      particleFall('❄', '#cfe8ff');
      eggToast('❄️ Let it snow');
      break;
    case 'fire':
      themeFlash('#FF5722', '#1a0d08', '🔥 Lit');
      particleRise('🔥');
      break;
    case 'disco':
      discoLights();
      eggToast('🕺 Disco fever');
      break;
    case 'graduation':
      themeFlash('#FF6FB5', '#1a0f1f', 'Graduation 🎓');
      particleRise('🎓');
      break;
    case 'donda':
      themeFlash('#1a1a1a', '#000000', 'DONDA');
      break;
    case 'stars':
      particleFall('⭐', '#ffe680');
      eggToast('✨ Reach for the stars');
      break;
    case 'glitch':
      glitchEffect();
      eggToast('g̷l̴i̶t̷c̸h̴');
      break;
    case 'zen':
      themeFlash('#5FE0A8', '#0c1a14', '🧘 Breathe');
      break;
    default:
      eggToast('???');
  }
}

// Small transient toast at the bottom of the window.
function eggToast(text, ms = 2800) {
  let toast = document.getElementById('egg-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'egg-toast';
    toast.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;font-weight:600;z-index:10000;max-width:80%;text-align:center;pointer-events:none;transition:opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, ms);
}

// Briefly flash a theme (accent + bg), then revert to whatever was set.
function themeFlash(accent, bg, label) {
  const root = document.documentElement;
  const prev = {
    indigo: root.style.getPropertyValue('--indigo'),
    sky: root.style.getPropertyValue('--sky'),
    dynBg: root.style.getPropertyValue('--dyn-bg'),
    dynBgR: root.style.getPropertyValue('--dyn-bg-raised'),
    dynamic: document.body.classList.contains('dynamic-theme'),
  };
  root.style.setProperty('--indigo', accent);
  root.style.setProperty('--sky', accent);
  root.style.setProperty('--dyn-bg', bg);
  root.style.setProperty('--dyn-bg-raised', bg.replace(/^#/, '#1'));
  document.body.classList.add('dynamic-theme');
  if (label) eggToast(label);
  setTimeout(() => {
    // Revert
    if (prev.indigo) root.style.setProperty('--indigo', prev.indigo); else root.style.removeProperty('--indigo');
    if (prev.sky) root.style.setProperty('--sky', prev.sky); else root.style.removeProperty('--sky');
    if (prev.dynBg) root.style.setProperty('--dyn-bg', prev.dynBg); else root.style.removeProperty('--dyn-bg');
    if (prev.dynBgR) root.style.setProperty('--dyn-bg-raised', prev.dynBgR); else root.style.removeProperty('--dyn-bg-raised');
    if (!prev.dynamic) document.body.classList.remove('dynamic-theme');
  }, 6000);
}

// Cycle the accent through the rainbow for a few seconds.
function rainbowAccent() {
  const root = document.documentElement;
  let hue = 0;
  const start = Date.now();
  const iv = setInterval(() => {
    hue = (hue + 8) % 360;
    const c = `hsl(${hue}, 80%, 60%)`;
    root.style.setProperty('--indigo', c);
    root.style.setProperty('--sky', c);
    if (Date.now() - start > 5000) {
      clearInterval(iv);
      root.style.removeProperty('--indigo');
      root.style.removeProperty('--sky');
    }
  }, 60);
}

// Matrix-style green digital rain overlay for a few seconds.
function matrixRain() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9998;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const cols = Math.floor(canvas.width / 14);
  const drops = new Array(cols).fill(0).map(() => Math.random() * -50);
  const chars = 'アイウエオカキ0123456789ABCDEF';
  const start = Date.now();
  function draw() {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0F0';
    ctx.font = '14px monospace';
    for (let i = 0; i < drops.length; i++) {
      const ch = chars[Math.floor(Math.random() * chars.length)];
      ctx.fillText(ch, i * 14, drops[i] * 14);
      if (drops[i] * 14 > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    if (Date.now() - start < 5000) {
      requestAnimationFrame(draw);
    } else {
      canvas.style.transition = 'opacity 0.6s';
      canvas.style.opacity = '0';
      setTimeout(() => canvas.remove(), 700);
    }
  }
  draw();
}

// Generic particles falling from the top (snow, stars).
function particleFall(char, color) {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden;';
  document.body.appendChild(container);
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('div');
    p.textContent = char;
    const left = Math.random() * 100;
    const size = 10 + Math.random() * 18;
    const dur = 3 + Math.random() * 4;
    const delay = Math.random() * 3;
    p.style.cssText = `position:absolute;left:${left}%;top:-30px;font-size:${size}px;color:${color};opacity:0.9;animation:particle-fall ${dur}s linear ${delay}s forwards;`;
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 8000);
}

// Generic particles rising from the bottom (fire, graduation caps).
function particleRise(char) {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden;';
  document.body.appendChild(container);
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.textContent = char;
    const left = Math.random() * 100;
    const size = 16 + Math.random() * 22;
    const dur = 2.5 + Math.random() * 2;
    const delay = Math.random() * 1.5;
    p.style.cssText = `position:absolute;left:${left}%;bottom:-40px;font-size:${size}px;animation:paw-float ${dur}s ease-in ${delay}s forwards;`;
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 5500);
}

// Disco: rapidly cycling colorful flashes over the whole window.
function discoLights() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9997;mix-blend-mode:overlay;';
  document.body.appendChild(overlay);
  let n = 0;
  const iv = setInterval(() => {
    overlay.style.background = `hsl(${Math.random() * 360}, 90%, 55%)`;
    if (++n > 40) {
      clearInterval(iv);
      overlay.style.transition = 'opacity 0.5s';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 600);
    }
  }, 120);
}

// Glitch: briefly shakes/skews the whole app with a jitter.
function glitchEffect() {
  document.body.style.transition = 'none';
  let n = 0;
  const iv = setInterval(() => {
    const x = (Math.random() - 0.5) * 8;
    const y = (Math.random() - 0.5) * 8;
    const skew = (Math.random() - 0.5) * 3;
    document.body.style.transform = `translate(${x}px, ${y}px) skew(${skew}deg)`;
    document.body.style.filter = Math.random() > 0.7 ? 'hue-rotate(90deg)' : 'none';
    if (++n > 20) {
      clearInterval(iv);
      document.body.style.transform = '';
      document.body.style.filter = '';
    }
  }, 70);
}
