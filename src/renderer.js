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

// Home hero -- a lightweight mirror of the Now Playing header, so the front
// page shows what's playing at a glance without needing to switch tabs.
const elHomeHeroDot = document.getElementById('home-hero-dot');
const elHomeHeroStatus = document.getElementById('home-hero-status');
const elHomeHeroTrack = document.getElementById('home-hero-track');
const elHomeHeroArtist = document.getElementById('home-hero-artist');
const elHomeHeroArt = document.getElementById('home-hero-art');
const elHomeHeroArtFallback = document.getElementById('home-hero-art-fallback');

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
const elTabBtnHome = document.getElementById('tab-btn-home');
const elTabBtnNowPlaying = document.getElementById('tab-btn-now-playing');
const elTabBtnLeaderboard = document.getElementById('tab-btn-leaderboard');
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
  if (elHomeHeroDot) elHomeHeroDot.className = state.connected ? 'live' : 'off';
  if (elHomeHeroStatus) elHomeHeroStatus.textContent = state.connected ? 'Connected' : 'Not connected';

  // Track info
  const track = state.track;
  if (track && (track.state === 'playing' || track.state === 'paused')) {
    // Drives the equalizer bars, groove shimmer, and album-art float -- only
    // while actually playing, so paused freezes them.
    document.body.classList.toggle('is-playing', track.state === 'playing');
    elTrackName.textContent = track.name || 'Unknown track';
    elTrackArtist.textContent = track.artist || 'Unknown artist';
    if (elHomeHeroTrack) elHomeHeroTrack.textContent = track.name || 'Unknown track';
    if (elHomeHeroArtist) elHomeHeroArtist.textContent = track.artist || 'Unknown artist';

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
    const artSrc = track.artworkDataUrl || track.artworkHttpUrl || null;
    if (artSrc) {
      elArtImg.src = artSrc;
      elArtImg.style.display = 'block';
      elArtFallback.style.display = 'none';
      if (songChanged) replayAnimation(elArtImg, 'art-animate');
      // Dynamic theme: pull the dominant color from the new cover and retint
      // the UI. Only on song change so we don't re-extract every tick.
      if (songChanged) applyThemeFromArtwork(artSrc);
      if (elHomeHeroArt) elHomeHeroArt.style.backgroundImage = `url("${artSrc}")`;
      if (elHomeHeroArtFallback) elHomeHeroArtFallback.style.display = 'none';
    } else {
      elArtImg.style.display = 'none';
      elArtFallback.style.display = 'flex';
      if (songChanged) replayAnimation(elArtFallback, 'art-animate');
      if (songChanged) resetTheme();
      if (elHomeHeroArt) elHomeHeroArt.style.backgroundImage = '';
      if (elHomeHeroArtFallback) elHomeHeroArtFallback.style.display = 'flex';
    }
  } else {
    liveTrack = null;
    lastAnimatedSongKey = null;
    document.body.classList.remove('is-playing');
    resetTheme();
    elTrackName.textContent = 'Nothing playing';
    elTrackArtist.textContent = 'Open Apple Music and press play';
    if (elHomeHeroTrack) elHomeHeroTrack.textContent = 'Nothing playing';
    if (elHomeHeroArtist) elHomeHeroArtist.textContent = 'Open Apple Music and press play';
    if (elHomeHeroArt) elHomeHeroArt.style.backgroundImage = '';
    if (elHomeHeroArtFallback) elHomeHeroArtFallback.style.display = 'flex';
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
    const favd = isFavorite(entry.username);
    if (favd) row.classList.add('favorited');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name"></span>
      <span class="lb-time"></span>
      <button class="lb-fav ${favd ? 'favorited' : ''}" title="Favorite">${favd ? '\u2605' : '\u2606'}</button>
    `;
    // Set text via textContent (not innerHTML) so a username can never be
    // interpreted as markup -- usernames are arbitrary user input from
    // potentially many different people, shared across everyone's window.
    row.querySelector('.lb-name').textContent = entry.username || 'Unknown';
    row.querySelector('.lb-time').textContent = formatListeningTime(entry.totalSeconds);
    // Don't let a user favorite themselves.
    const favBtn = row.querySelector('.lb-fav');
    if (entry.username === currentUsername) {
      favBtn.style.visibility = 'hidden';
    } else {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(entry.username);
        const nowFav = isFavorite(entry.username);
        favBtn.classList.toggle('favorited', nowFav);
        favBtn.textContent = nowFav ? '\u2605' : '\u2606';
        row.classList.toggle('favorited', nowFav);
      });
    }
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
  document.body.classList.toggle('tab-home', tab === 'home');
  document.body.classList.toggle('tab-now-playing', tab === 'now-playing');
  document.body.classList.toggle('tab-leaderboard', tab === 'leaderboard');
  document.body.classList.toggle('tab-dev', tab === 'dev');
  document.body.classList.toggle('tab-recs', tab === 'recs');
  document.body.classList.toggle('tab-pet', tab === 'pet');
  document.body.classList.toggle('tab-settings', tab === 'settings');
  document.body.classList.toggle('tab-townhall', tab === 'townhall');
  document.body.classList.toggle('tab-profile', tab === 'profile');
  if (elTabBtnHome) elTabBtnHome.classList.toggle('active', tab === 'home');
  elTabBtnNowPlaying.classList.toggle('active', tab === 'now-playing');
  elTabBtnLeaderboard.classList.toggle('active', tab === 'leaderboard');
  elTabBtnDev.classList.toggle('active', tab === 'dev');
  elTabBtnRecs.classList.toggle('active', tab === 'recs');
  if (elTabBtnPet) elTabBtnPet.classList.toggle('active', tab === 'pet');
  elTabBtnSettings.classList.toggle('active', tab === 'settings');

  if (tab === 'home') updateHomeProfileLabel();
  if (tab === 'profile') loadProfile();

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

  if (tab === 'recs') loadRecommendations();
  if (tab === 'pet') { loadPet(); if (!petRefreshTimer) petRefreshTimer = setInterval(loadPet, 15000); }
  else if (petRefreshTimer) { clearInterval(petRefreshTimer); petRefreshTimer = null; }
}

const elTabBtnPet = document.getElementById('tab-btn-pet');
let petRefreshTimer = null;

function updateHomeProfileLabel() {
  const el = document.getElementById('home-header-profile');
  if (el) el.title = currentUsername ? `Profile (${currentUsername})` : 'Profile';
}

if (elTabBtnHome) elTabBtnHome.addEventListener('click', () => showTab('home'));

// Home grid tiles, header icon buttons, and the Town Hall stub each just
// route into the existing tabs.
document.querySelectorAll('[data-go]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.go));
});
const elTownhallBack = document.getElementById('townhall-back');
if (elTownhallBack) elTownhallBack.addEventListener('click', () => showTab('home'));

const elProfileBack = document.getElementById('profile-back');
if (elProfileBack) elProfileBack.addEventListener('click', () => showTab('home'));
const elProfileSetUsername = document.getElementById('profile-set-username');
if (elProfileSetUsername) elProfileSetUsername.addEventListener('click', () => showTab('settings'));

// Pulls together the username + a couple of headline stats for the
// standalone Profile screen (separate from Settings, which is toggles only).
function loadProfile() {
  const nameEl = document.getElementById('profile-username');
  const letterEl = document.getElementById('profile-avatar-letter');
  const setBtn = document.getElementById('profile-set-username');
  const hoursEl = document.getElementById('profile-stat-hours');
  const streakEl = document.getElementById('profile-stat-streak');

  const name = currentUsername;
  if (nameEl) nameEl.textContent = name || 'Not set';
  if (letterEl) letterEl.textContent = name ? name.trim()[0].toUpperCase() : '?';
  if (setBtn) setBtn.style.display = name ? 'none' : 'block';

  window.musicToDiscord.getAchievements().then((data) => {
    if (hoursEl && data && data.stats) {
      hoursEl.textContent = Math.round((data.stats.totalHours || 0) * 10) / 10;
    }
  }).catch(() => {});

  window.musicToDiscord.getStreaks().then((data) => {
    if (streakEl && data) streakEl.textContent = data.current || 0;
  }).catch(() => {});
}

elTabBtnNowPlaying.addEventListener('click', () => showTab('now-playing'));
elTabBtnLeaderboard.addEventListener('click', () => showTab('leaderboard'));
elTabBtnDev.addEventListener('click', () => showTab('dev'));
elTabBtnRecs.addEventListener('click', () => showTab('recs'));
if (elTabBtnPet) elTabBtnPet.addEventListener('click', () => showTab('pet'));
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

// Refresh achievements live when the main process unlocks one mid-session
// (used by the Profile screen's stats).
window.musicToDiscord.onAchievementsChanged(() => {
  celebrate();
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
  // Load favorited users.
  favoriteUsers = new Set((settings && settings.favoriteUsers) || []);

  // Mature content filter: default ON unless explicitly turned off.
  const matureOn = !settings || settings.hideMatureContent !== false;
  applyMatureToggle(matureOn);
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

// Mature content filter toggle.
const elToggleMature = document.getElementById('toggle-mature');
function applyMatureToggle(on) {
  if (elToggleMature) {
    elToggleMature.classList.toggle('on', !!on);
    elToggleMature.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}
(function initMatureToggle() {
  if (!elToggleMature) return;
  function toggle() {
    const on = !elToggleMature.classList.contains('on');
    applyMatureToggle(on);
    window.musicToDiscord.setSetting('hideMatureContent', on);
  }
  elToggleMature.addEventListener('click', toggle);
  elToggleMature.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
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

// ================================================================
// MK CONNECT
// ================================================================
// Mirrors now-playing to a user's MK (a Discord-lookalike chat app) account,
// same idea as the Discord sync above but hitting MK's own REST API. Login
// exchanges username/password for a token once (main process stores it);
// after that this is just a toggle plus a "song - artist" push on change.
(function initMkConnect() {
  const loginFields = document.getElementById('mk-login-fields');
  const connectedFields = document.getElementById('mk-connected-fields');
  const statusSub = document.getElementById('mk-status-sub');
  const urlInput = document.getElementById('mk-url-input');
  const usernameInput = document.getElementById('mk-username-input');
  const passwordInput = document.getElementById('mk-password-input');
  const errorEl = document.getElementById('mk-login-error');
  const connectBtn = document.getElementById('mk-connect-btn');
  const disconnectBtn = document.getElementById('mk-disconnect-btn');
  const toggleEnabled = document.getElementById('toggle-mk-enabled');
  if (!loginFields || !connectedFields) return;

  function render(status) {
    const linked = !!(status && status.linked);
    loginFields.style.display = linked ? 'none' : 'flex';
    connectedFields.style.display = linked ? 'flex' : 'none';
    if (statusSub) {
      statusSub.textContent = linked
        ? `Connected as ${status.username} (${status.apiUrl})`
        : 'Not connected';
    }
    if (toggleEnabled && status) {
      toggleEnabled.classList.toggle('on', !!status.enabled);
      toggleEnabled.setAttribute('aria-checked', status.enabled ? 'true' : 'false');
    }
  }

  function refresh() {
    window.musicToDiscord.mkStatus().then(render).catch(() => {});
  }

  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const apiUrl = (urlInput?.value || '').trim();
      const username = (usernameInput?.value || '').trim();
      const password = passwordInput?.value || '';
      if (errorEl) errorEl.style.display = 'none';
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      window.musicToDiscord.mkLogin({ apiUrl, username, password }).then((result) => {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        if (result && result.ok) {
          if (passwordInput) passwordInput.value = '';
          refresh();
        } else if (errorEl) {
          errorEl.textContent = (result && result.error) || 'Could not connect.';
          errorEl.style.display = 'block';
        }
      }).catch(() => {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        if (errorEl) {
          errorEl.textContent = 'Could not reach MK.';
          errorEl.style.display = 'block';
        }
      });
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
      window.musicToDiscord.mkLogout().then(refresh).catch(() => {});
    });
  }

  if (toggleEnabled) {
    function toggle() {
      const on = !toggleEnabled.classList.contains('on');
      toggleEnabled.classList.toggle('on', on);
      toggleEnabled.setAttribute('aria-checked', on ? 'true' : 'false');
      window.musicToDiscord.setSetting('mkEnabled', on);
    }
    toggleEnabled.addEventListener('click', toggle);
    toggleEnabled.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  if (window.musicToDiscord.onMkStatusChanged) {
    window.musicToDiscord.onMkStatusChanged(refresh);
  }

  refresh();
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
//   0-4  -> switch tabs (Home / Now Playing / Leaderboard / For You / Settings)
//   M    -> toggle mini always-on-top mode
// Ignored while typing in an input so we don't hijack the search box etc.
(function initShortcuts() {
  const TAB_KEYS = {
    '0': 'home',
    '1': 'now-playing',
    '2': 'leaderboard',
    '3': 'recs',
    '4': 'settings',
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
//   GOODMORNING      -> replays the Home screen's cinematic boot intro
//   BEAR             -> the Dropout Bear floats up across the screen
//   POWER            -> flash a "Power" red/black theme
//   PABLO            -> flash a "The Life of Pablo" cream theme
//   SECRET           -> reveals the full list of codes as a toast
//
// Two more eggs beyond the code box:
//   - Rapid-clicking the album art (Now Playing) does a DJ record scratch.
//   - Rapid-clicking the Home wordmark replays the GOODMORNING intro.
//   - The classic Konami code (↑↑↓↓←→←→BA) works anywhere in the window.
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
      eggToast('Codes: CONFETTI · RAINBOW · MATRIX · GOLDEN · VAPOR · 808S · YEEZY · BARKING · SNOW · FIRE · DISCO · STARS · GLITCH · ZEN · GOODMORNING · BEAR · POWER · PABLO', 8000);
      break;
    case 'goodmorning':
      playGoodMorningIntro();
      break;
    case 'bear':
      particleRise('🐻');
      eggToast('🐻 Dropout Bear says hi');
      break;
    case 'power':
      themeFlash('#C0392B', '#1a0808', '"No one man should have all that power" 👑');
      break;
    case 'pablo':
      themeFlash('#D8C9A3', '#1a1710', 'The Life of Pablo');
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
    case 'peaschickentree':
      petSound('peaschickentree');
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

// Cinematic Home boot intro: fade up from black with the wordmark zooming
// in and flaring bright, a nod to the stark rising-glow title-card look the
// Home screen was designed around. Triggered by the GOODMORNING code or by
// rapid-clicking the wordmark itself.
function playGoodMorningIntro() {
  showTab('home');
  const view = document.getElementById('view-home');
  const logo = document.getElementById('home-logo');
  if (!view) return;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;background:#000;z-index:5;opacity:1;transition:opacity 1.6s ease;pointer-events:none;';
  view.appendChild(overlay);

  if (logo) {
    logo.style.transition = 'none';
    logo.style.transform = 'scale(0.7)';
    logo.style.filter = 'brightness(0.25)';
  }

  eggToast('Wake up, get up, get out the bed...', 3200);

  requestAnimationFrame(() => {
    setTimeout(() => {
      overlay.style.opacity = '0';
      if (logo) {
        logo.style.transition = 'transform 1.8s cubic-bezier(0.22,1,0.36,1), filter 1.8s ease';
        logo.style.transform = 'scale(1)';
        logo.style.filter = 'brightness(1.7)';
        setTimeout(() => { logo.style.filter = ''; }, 1800);
      }
      setTimeout(() => overlay.remove(), 1700);
    }, 150);
  });
}

// DJ record scratch: rapidly wobble the album art, then settle back.
function recordScratch() {
  const art = document.getElementById('art-wrap');
  if (!art) return;
  const prevTransition = art.style.transition;
  const prevTransform = art.style.transform;
  art.style.transition = 'transform 0.12s linear';
  let n = 0;
  const iv = setInterval(() => {
    const deg = (n % 2 === 0) ? 35 : -25;
    art.style.transform = `rotate(${deg}deg) scale(1.05)`;
    if (++n > 10) {
      clearInterval(iv);
      art.style.transition = 'transform 0.4s cubic-bezier(0.22,1,0.36,1)';
      art.style.transform = prevTransform || '';
      setTimeout(() => { art.style.transition = prevTransition || ''; }, 450);
    }
  }, 90);
  eggToast('🎧 Scratch!');
}

// Rapid-click detector: fires callback once `count` clicks land on `el`
// within `windowMs` of each other.
function trackRapidClicks(el, count, windowMs, callback) {
  if (!el) return;
  let clicks = [];
  el.addEventListener('click', () => {
    const now = Date.now();
    clicks.push(now);
    clicks = clicks.filter((t) => now - t <= windowMs);
    if (clicks.length >= count) {
      clicks = [];
      callback();
    }
  });
}
trackRapidClicks(document.getElementById('art-wrap'), 8, 2500, recordScratch);
trackRapidClicks(document.getElementById('home-logo-text'), 5, 3000, playGoodMorningIntro);

// Classic Konami code (↑↑↓↓←→←→BA), purely cosmetic, works anywhere the
// user isn't actively typing.
(function initKonami() {
  const seq = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
  let pos = 0;
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const key = e.key.toLowerCase();
    if (key === seq[pos]) {
      pos++;
      if (pos === seq.length) {
        pos = 0;
        rainbowAccent();
        celebrate();
        eggToast('🎮 KONAMI CODE — 30 extra lives (purely cosmetic)', 4000);
      }
    } else {
      pos = (key === seq[0]) ? 1 : 0;
    }
  });
})();

// ================================================================
// FRIEND FAVORITES
// ================================================================
// Users can star others on the leaderboard to highlight them. The list of
// favorited usernames is stored locally via settings. Favorited users get a
// green border on the leaderboard and are highlighted in the ticker.
let favoriteUsers = new Set();

function loadFavorites() {
  window.musicToDiscord.getSettings().then((settings) => {
    const list = (settings && settings.favoriteUsers) || [];
    favoriteUsers = new Set(list);
  });
}
function isFavorite(name) { return favoriteUsers.has(name); }
function toggleFavorite(name) {
  if (favoriteUsers.has(name)) favoriteUsers.delete(name);
  else favoriteUsers.add(name);
  window.musicToDiscord.setSetting('favoriteUsers', [...favoriteUsers]);
}

// ================================================================
// GLOBAL NOW-PLAYING TICKER
// ================================================================
// Scrolls what everyone's currently listening to across the Now Playing
// screen. Reuses the listening-party presence data. Favorited users are
// highlighted. Hidden when nobody (or only you) is listening.
(function initTicker() {
  // Multiple screens (Now Playing, Home) each host their own ticker instance;
  // both share this one refresh loop, matched up by DOM order.
  const wraps = Array.from(document.querySelectorAll('.ticker-wrap'));
  const tracks = Array.from(document.querySelectorAll('.ticker-track'));
  if (!wraps.length || !tracks.length) return;

  async function refresh() {
    try {
      const data = await window.musicToDiscord.getListeningParty();
      if (!data || data.total === 0) {
        wraps.forEach((w) => { w.style.display = 'none'; });
        return;
      }
      // Build one item per listener. Duplicate the sequence so the loop scroll
      // (translateX -50%) is seamless.
      const items = data.listeners.map((l) => {
        const favClass = isFavorite(l.username) ? 'ticker-fav' : 'ticker-user';
        const star = isFavorite(l.username) ? '\u2605 ' : '';
        return `<span class="ticker-item"><span class="${favClass}">${star}${esc(l.username)}</span> \u2192 ${esc(l.song)}${l.artist ? ' \u2014 ' + esc(l.artist) : ''}</span>`;
      }).join('');
      const html = items + items; // duplicated for seamless loop
      tracks.forEach((t) => { t.innerHTML = html; });
      wraps.forEach((w) => { w.style.display = 'block'; });
    } catch (e) {
      wraps.forEach((w) => { w.style.display = 'none'; });
    }
  }

  refresh();
  setInterval(refresh, 20000);
})();

// ================================================================
// MUSIC PET
// ================================================================
function renderPet(pet) {
  if (!pet) return;
  document.getElementById('pet-name').textContent = pet.name;

  // Vibing state: show gear + sway when actively grooving to a matched genre.
  const vibeClasses = ['vibe-hiphop', 'vibe-rock', 'vibe-pop', 'vibe-rbsoul',
    'vibe-electronic', 'vibe-jazz', 'vibe-classical', 'vibe-country'];
  document.body.classList.remove('pet-vibing', ...vibeClasses);
  if (pet.isVibing && pet.vibingGenre) {
    document.body.classList.add('pet-vibing');
    const g = pet.vibingGenre.toLowerCase();
    let cls = null;
    if (g.includes('hip')) cls = 'vibe-hiphop';
    else if (g.includes('rock')) cls = 'vibe-rock';
    else if (g.includes('pop')) cls = 'vibe-pop';
    else if (g.includes('r&b') || g.includes('soul')) cls = 'vibe-rbsoul';
    else if (g.includes('electronic')) cls = 'vibe-electronic';
    else if (g.includes('jazz')) cls = 'vibe-jazz';
    else if (g.includes('classical')) cls = 'vibe-classical';
    else if (g.includes('country')) cls = 'vibe-country';
    if (cls) document.body.classList.add(cls);
  }

  // Mood + party classes
  document.body.classList.remove('pet-happy', 'pet-sad', 'pet-sick', 'pet-dead', 'pet-party');
  if (!pet.alive) {
    document.body.classList.add('pet-dead');
  } else if (pet.partyMode) {
    document.body.classList.add('pet-party');
  } else if (pet.cleanliness < 30) {
    document.body.classList.add('pet-sick');
  } else if (pet.happiness >= 70) {
    document.body.classList.add('pet-happy');
  } else if (pet.happiness < 40) {
    document.body.classList.add('pet-sad');
  }

  // Craving / status line
  const cravingEl = document.getElementById('pet-craving');
  const deadMsg = document.getElementById('pet-dead-msg');
  const actions = document.getElementById('pet-actions');
  if (!pet.alive) {
    cravingEl.textContent = '';
    deadMsg.style.display = 'block';
    actions.style.display = 'none';
  } else {
    deadMsg.style.display = 'none';
    actions.style.display = 'flex';
    if (pet.partyMode) {
      cravingEl.textContent = 'PARTY TIME! His friends came to celebrate!';
    } else if (pet.songRequest) {
      cravingEl.textContent = `Wants to hear: "${pet.songRequest.name}" by ${pet.songRequest.artist}`;
    } else if (pet.hunger < 60) {
      cravingEl.textContent = 'Getting hungry — keep the music playing!';
    } else {
      cravingEl.textContent = 'Content — keep the music going!';
    }
  }

  // Stat bars
  setPetBar('pet-hunger', pet.hunger);
  setPetBar('pet-clean', pet.cleanliness);
  setPetBar('pet-happy', pet.happiness);

  // Poop
  const layer = document.getElementById('pet-poop-layer');
  layer.innerHTML = '';
  const positions = [[30, 130], [150, 120], [80, 145], [120, 60], [50, 50]];
  for (let i = 0; i < (pet.poop || 0); i++) {
    const p = document.createElement('div');
    p.className = 'pet-poop';
    p.textContent = '\ud83d\udca9';
    const [x, y] = positions[i % positions.length];
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.title = 'Click to clean';
    p.addEventListener('click', () => {
      window.musicToDiscord.petClean().then(renderPet);
    });
    layer.appendChild(p);
  }
}

function setPetBar(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, val))}%`;
  el.classList.toggle('low', val < 30);
}

function loadPet() {
  window.musicToDiscord.getPet().then(renderPet);
}

(function initPetControls() {
  const cleanBtn = document.getElementById('pet-clean-btn');
  const playBtn = document.getElementById('pet-play-btn');
  const renameBtn = document.getElementById('pet-rename-btn');
  if (cleanBtn) cleanBtn.addEventListener('click', () => window.musicToDiscord.petClean().then(renderPet));
  if (playBtn) playBtn.addEventListener('click', () => window.musicToDiscord.petPlay().then(renderPet));
  if (renameBtn) renameBtn.addEventListener('click', () => {
    const input = document.getElementById('pet-rename-input');
    const confirm = document.getElementById('pet-rename-confirm');
    const nameSpan = document.getElementById('pet-name');
    renameBtn.style.display = 'none';
    input.value = nameSpan.textContent || '';
    input.style.display = '';
    confirm.style.display = '';
    input.focus();
    input.select();

    function doRename() {
      const name = input.value.trim();
      input.style.display = 'none';
      confirm.style.display = 'none';
      renameBtn.style.display = '';
      if (name) window.musicToDiscord.petRename(name).then(renderPet);
    }

    confirm.onclick = doRename;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') doRename();
      if (e.key === 'Escape') {
        input.style.display = 'none';
        confirm.style.display = 'none';
        renameBtn.style.display = '';
      }
    };
  });
})();

// Refresh the pet live when the main process feeds it (genre matched).
window.musicToDiscord.onPetChanged(() => {
  if (document.body.classList.contains('tab-pet')) loadPet();
});

// Fire confetti when Markus throws a party.
window.musicToDiscord.onPetParty(() => {
  celebrate();
  if (document.body.classList.contains('tab-pet')) loadPet();
});

// ---- Pet sound system ----
// Plays Markus's voice clips from assets/pet-sounds/*.mp3.
// petSound(clip) is fire-and-forget — interrupts any currently playing clip.
let _petAudio = null;
let _petAudioCtx = null;
function petSound(clip) {
  if (!clip) return;
  try {
    if (_petAudio) { _petAudio.pause(); _petAudio = null; }
    const base = window.location.protocol === 'file:'
      ? window.location.pathname.replace(/\/src\/index\.html$/, '').replace(/^\//, '')
      : '..';
    const src = `${base}/assets/pet-sounds/${clip}.mp3`;
    _petAudio = new Audio(src);
    _petAudio.volume = 1.0;
    // Route through Web Audio for a gain boost above 100%
    if (!_petAudioCtx) _petAudioCtx = new AudioContext();
    const source = _petAudioCtx.createMediaElementSource(_petAudio);
    const gain = _petAudioCtx.createGain();
    gain.gain.value = 2.5; // 250% volume
    source.connect(gain);
    gain.connect(_petAudioCtx.destination);
    _petAudioCtx.resume().then(() => _petAudio.play().catch(() => {}));
  } catch (e) { /* audio not critical */ }
}

// Play a mood sound whenever main.js fires pet-sound (fed, party, clean, etc.)
window.musicToDiscord.onPetSound((clip) => petSound(clip));

// Play a mood-based greeting when user opens the pet tab
const _origSwitchTab = window._switchTab;
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'pet') {
      window.musicToDiscord.getPetSound().then(petSound).catch(() => {});
    }
  });
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   