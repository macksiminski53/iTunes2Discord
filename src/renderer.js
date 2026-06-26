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
const elLeaderboardMonth = document.getElementById('leaderboard-month');
const elLeaderboardList = document.getElementById('leaderboard-list');
const elLeaderboardEmpty = document.getElementById('leaderboard-empty');
const elLeaderboardError = document.getElementById('leaderboard-error');

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

  // Dev / owner mode panel visibility
  applyDevModeState(state);
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

function showTab(tab) {
  const isLeaderboard = tab === 'leaderboard';
  document.body.classList.toggle('tab-leaderboard', isLeaderboard);
  elTabBtnNowPlaying.classList.toggle('active', !isLeaderboard);
  elTabBtnLeaderboard.classList.toggle('active', isLeaderboard);

  if (isLeaderboard) {
    loadLeaderboard();
    // Keep it reasonably fresh while the tab is actually open, without
    // polling Firestore in the background when the user isn't even
    // looking at it.
    if (!leaderboardRefreshTimer) {
      leaderboardRefreshTimer = setInterval(loadLeaderboard, 30000);
    }
  } else if (leaderboardRefreshTimer) {
    clearInterval(leaderboardRefreshTimer);
    leaderboardRefreshTimer = null;
  }
}

elTabBtnNowPlaying.addEventListener('click', () => showTab('now-playing'));
elTabBtnLeaderboard.addEventListener('click', () => showTab('leaderboard'));

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

    // Special codes -- activate mode and dismiss overlay without saving a real username
    if (result && result.ok === 'dev_mode') {
      elSetupOverlay.classList.remove('show');
      elSetupInput.value = '';
      elSetupSubmit.disabled = true;
      return;
    }
    if (result && result.ok === 'owner_mode') {
      elSetupOverlay.classList.remove('show');
      elSetupInput.value = '';
      elSetupSubmit.disabled = true;
      return;
    }
    if (result && result.reason === 'dev_mode_killed') {
      elSetupSubmit.disabled = false;
      showSetupError('Dev mode is currently disabled by the owner.');
      return;
    }

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

// ---- Dev / Owner mode panel ----

const elDevPanel = document.getElementById('dev-panel');
const elDevModeLabel = document.getElementById('dev-mode-label');
const elDevEntriesList = document.getElementById('dev-entries-list');
const elDevRefreshBtn = document.getElementById('dev-refresh-btn');
const elDevStatusLine = document.getElementById('dev-status-line');
const elOwnerKillRow = document.getElementById('owner-kill-row');
const elOwnerKillSwitchBtn = document.getElementById('owner-kill-switch-btn');

function formatDevTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function refreshDevPanel() {
  elDevEntriesList.innerHTML = '<div class="dev-entry-row" style="color:#5b3fa0;font-style:italic;">Loading…</div>';
  const entries = await window.musicToDiscord.devGetAllEntries();
  elDevEntriesList.innerHTML = '';

  if (!entries) {
    elDevEntriesList.innerHTML = '<div class="dev-entry-row" style="color:#ff5c5c;">Failed to load entries.</div>';
    return;
  }
  if (entries.length === 0) {
    elDevEntriesList.innerHTML = '<div class="dev-entry-row" style="color:#5b3fa0;font-style:italic;">No entries in Firestore.</div>';
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'dev-entry-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'dev-entry-name';
    nameEl.textContent = entry.username || '(no name)';
    const metaEl = document.createElement('span');
    metaEl.className = 'dev-entry-meta';
    metaEl.textContent = `${entry.month || '?'} · ${formatDevTime(entry.totalSeconds || 0)}`;
    const delBtn = document.createElement('button');
    delBtn.className = 'dev-entry-del';
    delBtn.textContent = '✕';
    delBtn.title = `Delete ${entry.id}`;
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete entry "${entry.id}"?`)) return;
      delBtn.disabled = true;
      const ok = await window.musicToDiscord.devDeleteEntry(entry.id);
      if (ok) {
        row.remove();
      } else {
        delBtn.disabled = false;
        elDevStatusLine.textContent = 'Delete failed.';
      }
    });
    row.appendChild(nameEl);
    row.appendChild(metaEl);
    row.appendChild(delBtn);
    elDevEntriesList.appendChild(row);
  });
  elDevStatusLine.textContent = `${entries.length} total entries`;
}

async function refreshOwnerKillSwitch() {
  const killed = await window.musicToDiscord.ownerGetKillSwitch();
  if (killed === null) return;
  elOwnerKillSwitchBtn.textContent = killed ? 'ENABLED (J@R3D is blocked)' : 'Disabled (J@R3D works)';
  elOwnerKillSwitchBtn.classList.toggle('killed', killed);
}

elDevRefreshBtn.addEventListener('click', refreshDevPanel);

elOwnerKillSwitchBtn.addEventListener('click', async () => {
  const currentlyKilled = elOwnerKillSwitchBtn.classList.contains('killed');
  const newState = !currentlyKilled;
  elOwnerKillSwitchBtn.disabled = true;
  const ok = await window.musicToDiscord.ownerSetKillSwitch(newState);
  elOwnerKillSwitchBtn.disabled = false;
  if (ok) {
    elOwnerKillSwitchBtn.textContent = newState ? 'ENABLED (J@R3D is blocked)' : 'Disabled (J@R3D works)';
    elOwnerKillSwitchBtn.classList.toggle('killed', newState);
  } else {
    elDevStatusLine.textContent = 'Kill switch update failed.';
  }
});

function applyDevModeState(state) {
  const devActive = !!state.devModeActive;
  const ownerActive = !!state.ownerModeActive;
  document.body.classList.toggle('dev-mode-active', devActive);
  document.body.classList.toggle('owner-mode-active', ownerActive);
  if (ownerActive) {
    elDevModeLabel.textContent = '🔴 OWNER MODE (R3D_EYE)';
  } else {
    elDevModeLabel.textContent = '⚡ DEV MODE (J@R3D)';
  }
  if (devActive) {
    refreshDevPanel();
    if (ownerActive) refreshOwnerKillSwitch();
  }
}

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
