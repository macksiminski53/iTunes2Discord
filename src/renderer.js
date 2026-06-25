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

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- Local real-time ticking ----
// state-update only arrives once per poll (every 15s), which made the
// progress bar visibly jump instead of flowing. We keep our own clock here:
// remember the position we were told and the wall-clock moment we were told
// it, then every second we extrapolate forward — exactly how Discord's own
// elapsed-time bar already behaves, just mirrored locally in this window.
let liveTrack = null;
let liveAnchorMs = 0;

// Avoids a visible timer "jump" when a state-update fires for a reason
// unrelated to playback (e.g. toggling the app's own Pause syncing switch,
// which resends whatever track data was last cached). We only trust new
// data enough to reset the anchor if the song, the play/pause state, or the
// reported position meaningfully disagrees with what we'd already predict.
function shouldReanchor(newTrack) {
  if (!liveTrack) return true;
  if (liveTrack.name !== newTrack.name || liveTrack.artist !== newTrack.artist) return true;
  if (liveTrack.state !== newTrack.state) return true;
  const predicted = liveTrack.state === 'playing'
    ? (liveTrack.position || 0) + (Date.now() - liveAnchorMs) / 1000
    : (liveTrack.position || 0);
  return Math.abs(predicted - (newTrack.position || 0)) > 2.5;
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

    if (shouldReanchor(track)) {
      liveAnchorMs = Date.now();
    }
    liveTrack = track;
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
window.musicToDiscord.getState().then(render);
window.musicToDiscord.onStateUpdate(render);
