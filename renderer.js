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
const elVersionSub = document.getElementById('version-sub');
const elBtnUpdate = document.getElementById('btn-update');
const elBtnQuit = document.getElementById('btn-quit');
const elBtnMin = document.getElementById('btn-min');
const elBtnClose = document.getElementById('btn-close');

// Leaderboard / tabs
const elTabBtnNowPlaying = document.getElementById('tab-btn-now-playing');
const elTabBtnLeaderboard = document.getElementById('tab-btn-leaderboard');
const elTabBtnWrapped = document.getElementById('tab-btn-wrapped');
const elTabBtnShare = document.getElementById('tab-btn-share');
const elTabBtnRecs = document.getElementById('tab-btn-recs');
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

  // Track info
  const track = state.track;
  if (track && (track.state === 'playing' || track.state === 'paused')) {
    elTrackName.textContent = track.name || 'Unknown track';
    elTrackArtist.textContent = track.artist || 'Unknown artist';

    reanchor(track);
    paintTime();

    if (track.artworkDataUrl) {
      elArtImg.src = track.artworkDataUrl;
      elArtImg.style.display = 'block';
      elArtFallback.style.display = 'none';
    } else {
      elArtImg.style.display = 'none';
      elArtFallback.style.display = 'flex';
    }
  } else {
    liveTrack = null;
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

  if (state.devMode) {
    elTabBtnDev.style.display = '';
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
    elLeaderboardError.style.display = 'block';
    return;
  }
  if (entries.length === 0) {
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
    elLeaderboardList.appendChild(row);
  });
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
  elTabBtnNowPlaying.classList.toggle('active', tab === 'now-playing');
  elTabBtnLeaderboard.classList.toggle('active', tab === 'leaderboard');
  elTabBtnDev.classList.toggle('active', tab === 'dev');
  elTabBtnWrapped.classList.toggle('active', tab === 'wrapped');
  elTabBtnShare.classList.toggle('active', tab === 'share');
  elTabBtnRecs.classList.toggle('active', tab === 'recs');

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
    const row = document.createElement('div');
    row.className = 'dev-entry-row';
    row.innerHTML = `
      <span class="dev-entry-name"></span>
      <span class="dev-entry-month"></span>
      <span class="dev-entry-time"></span>
      <button class="dev-entry-delete">DEL</button>
    `;
    row.querySelector('.dev-entry-name').textContent = entry.username || 'Unknown';
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
      statusEl.textContent = '✅ Sent';
      document.getElementById('owner-notif-body').value = '';
      document.getElementById('owner-notif-title').value = '';
    } else {
      statusEl.textContent = '❌ Failed';
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

elBtnUpdate.addEventListener('click', () => {
  elBtnUpdate.textContent = 'Checking…';
  window.musicToDiscord.checkForUpdates();
  setTimeout(() => { elBtnUpdate.textContent = 'Check for updates'; }, 3000);
});

elBtnQuit.addEventListener('click', () => window.musicToDiscord.quitApp());
elBtnMin.addEventListener('click', () => window.close());
elBtnClose.addEventListener('click', () => window.close());

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

  // Stats
  document.getElementById('wrapped-total-plays').textContent = data.totalPlays.toLocaleString();
  document.getElementById('wrapped-total-time').textContent = formatListeningTimeWrapped(data.totalSeconds);
  document.getElementById('wrapped-top-artist-short').textContent =
    data.topArtists[0] ? data.topArtists[0].artist.split(' ')[0] : '—';
  document.getElementById('wrapped-busiest-hour').textContent = formatHour(data.busiestHour);

  // Top songs
  const songsEl = document.getElementById('wrapped-top-songs');
  songsEl.innerHTML = data.topSongs.map((s, i) => `
    <div class="wrapped-rank-row">
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
    <div class="wrapped-rank-row">
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
      ? `⬇ Downloading v${info.version}…`
      : '⬇ Downloading update…';
    elUpdateBannerBtn.disabled = true;
  } else if (info.status === 'ready') {
    elUpdateBanner.classList.add('show');
    elUpdateBannerText.textContent = info.version
      ? `✅ v${info.version} ready to install`
      : '✅ Update ready to install';
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
    const text = `🎵 Listening to: ${name} by ${artist}${albumPart} — via MusicToDiscord`;
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Copied!';
    statusEl.textContent = 'Paste anywhere to share';
  } catch (e) {
    btn.textContent = '❌ Failed';
    statusEl.textContent = 'Could not access clipboard';
  }

  setTimeout(() => {
    btn.textContent = '📋 Copy as text';
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
      <div class="rec-icon">🎵</div>
      <div class="rec-info">
        <div class="rec-name">${esc(r.name)}</div>
        <div class="rec-artist">${esc(r.artist)}</div>
      </div>
    </div>
  `).join('');
}
