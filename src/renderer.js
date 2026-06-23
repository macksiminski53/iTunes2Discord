// src/renderer.js
let currentTrack = null;
let playData = { history: [], playCounts: {} };
let isConnected = false;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const albumArt = document.getElementById('albumArt');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const trackAlbum = document.getElementById('trackAlbum');
const trackState = document.getElementById('trackState');
const historyList = document.getElementById('historyList');
const leaderboardList = document.getElementById('leaderboardList');
const nowPlayingInfo = document.getElementById('nowPlayingInfo');

const playPauseBtn = document.getElementById('playPauseBtn');
const nextBtn = document.getElementById('nextBtn');
const prevBtn = document.getElementById('prevBtn');

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tabName = e.target.dataset.tab;
    
    // Remove active from all buttons and content
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // Add active to clicked button and corresponding content
    e.target.classList.add('active');
    document.getElementById(`${tabName}-content`).classList.add('active');
  });
});

// Controls
playPauseBtn.addEventListener('click', async () => {
  if (currentTrack?.state === 'playing') {
    await window.electronAPI.pauseTrack();
  } else {
    await window.electronAPI.playTrack();
  }
});

nextBtn.addEventListener('click', () => window.electronAPI.nextTrack());
prevBtn.addEventListener('click', () => window.electronAPI.previousTrack());

// Format time
function formatTime(ms) {
  const date = new Date(ms);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString();
}

// Update track display
function updateTrackDisplay(track) {
  currentTrack = track;

  if (track.state === 'not_running' || track.state === 'stopped') {
    trackTitle.textContent = 'Nothing playing';
    trackArtist.textContent = '';
    trackAlbum.textContent = '';
    trackState.textContent = '';
    albumArt.innerHTML = '🎵';
    playPauseBtn.disabled = true;
    nextBtn.disabled = true;
    prevBtn.disabled = true;
    nowPlayingInfo.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎵</div><p>iTunes/Music is not running</p></div>';
  } else {
    trackTitle.textContent = track.name || 'Unknown';
    trackArtist.textContent = track.artist || 'Unknown Artist';
    trackAlbum.textContent = track.album || '';
    trackState.textContent = track.state === 'playing' ? '▶ Playing' : '⏸ Paused';
    trackState.classList.toggle('paused', track.state === 'paused');

    // Album art
    if (track.artworkPath) {
      albumArt.innerHTML = `<img src="file://${track.artworkPath}" alt="Album art" />`;
    } else {
      albumArt.innerHTML = '🎵';
    }

    // Controls
    playPauseBtn.disabled = false;
    nextBtn.disabled = false;
    prevBtn.disabled = false;
    playPauseBtn.textContent = track.state === 'playing' ? '⏸ Pause' : '▶ Play';

    // Now Playing info
    const duration = track.duration ? Math.floor(track.duration / 60) : 0;
    const position = track.position ? Math.floor(track.position / 60) : 0;
    nowPlayingInfo.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <div style="font-size: 12px; color: #808080; margin-bottom: 4px;">Duration</div>
          <div style="font-size: 14px;">${position}:${String(Math.floor((track.position % 60) || 0)).padStart(2, '0')} / ${duration}:${String(Math.floor((track.duration % 60) || 0)).padStart(2, '0')}</div>
        </div>
        <div>
          <div style="font-size: 12px; color: #808080; margin-bottom: 4px;">State</div>
          <div style="font-size: 14px;">${track.state === 'playing' ? '▶ Playing' : '⏸ Paused'}</div>
        </div>
      </div>
    `;
  }
}

// Update history display
function updateHistory() {
  if (playData.history.length === 0) {
    historyList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><p>No playback history yet</p></div>';
    return;
  }

  const recent = playData.history.slice(-50).reverse();
  historyList.innerHTML = recent.map(entry => `
    <div class="history-item">
      <div class="track-title" style="margin-bottom: 3px;">${entry.name}</div>
      <div class="track-artist" style="margin-bottom: 3px;">${entry.artist}</div>
      <div class="history-time">${formatTime(entry.timestamp)}</div>
    </div>
  `).join('');
}

// Update leaderboard display
function updateLeaderboard() {
  const tracks = Object.values(playData.playCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  if (tracks.length === 0) {
    leaderboardList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏆</div><p>No plays recorded yet</p></div>';
    return;
  }

  leaderboardList.innerHTML = tracks.map((track, idx) => `
    <div class="leaderboard-item">
      <div class="leaderboard-rank">#${idx + 1}</div>
      <div class="leaderboard-info">
        <div class="leaderboard-title">${track.name}</div>
        <div class="leaderboard-artist">${track.artist}</div>
      </div>
      <div class="leaderboard-count">${track.count}x</div>
    </div>
  `).join('');
}

// Update status
function updateStatus() {
  if (isConnected) {
    statusDot.classList.add('connected');
    statusText.textContent = '✅ Connected to Discord';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = '❌ Not connected to Discord';
  }
}

// IPC Listeners
window.electronAPI.onTrackUpdate((track) => {
  updateTrackDisplay(track);
});

window.electronAPI.onDataUpdate((data) => {
  playData = data;
  updateHistory();
  updateLeaderboard();
});

window.electronAPI.onDiscordConnected(() => {
  isConnected = true;
  updateStatus();
});

window.electronAPI.onDiscordDisconnected(() => {
  isConnected = false;
  updateStatus();
});

// Initial load
(async () => {
  const data = await window.electronAPI.getPlayData();
  playData = data;
  updateHistory();
  updateLeaderboard();
})();
