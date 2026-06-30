// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicToDiscord', {
  // Renderer asks for the latest known track/connection state on load
  getState: () => ipcRenderer.invoke('get-state'),

  // Main process pushes updates whenever something changes
  onStateUpdate: (callback) => {
    ipcRenderer.on('state-update', (_event, state) => callback(state));
  },

  // Renderer-initiated actions
  togglePause: () => ipcRenderer.send('toggle-pause'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  quitApp: () => ipcRenderer.send('quit-app'),

  // Leaderboard
  getUsername: () => ipcRenderer.invoke('get-username'),
  setUsername: (name) => ipcRenderer.invoke('set-username', name),
  getLeaderboard: () => ipcRenderer.invoke('get-leaderboard'),
  deleteMyStats: () => ipcRenderer.invoke('delete-my-stats'),
  clearUsername: () => ipcRenderer.invoke('clear-username'),

  // Wrapped
  getWrapped: (monthKey) => ipcRenderer.invoke('get-wrapped', monthKey),
  getWrappedMonths: () => ipcRenderer.invoke('get-wrapped-months'),
  resetWrapped: () => ipcRenderer.invoke('reset-wrapped'),
  getThrowback: () => ipcRenderer.invoke('get-throwback'),

  // Achievements
  getAchievements: () => ipcRenderer.invoke('get-achievements'),
  getDailyGoal: () => ipcRenderer.invoke('get-daily-goal'),
  getListeningParty: () => ipcRenderer.invoke('get-listening-party'),
  getHistory: (query) => ipcRenderer.invoke('get-history', query),
  toggleMiniMode: (on) => ipcRenderer.invoke('toggle-mini-mode', on),
  setSleepTimer: (minutes) => ipcRenderer.invoke('set-sleep-timer', minutes),
  onSleepTimerFired: (callback) => ipcRenderer.on('sleep-timer-fired', () => callback()),
  onAchievementsChanged: (callback) => {
    ipcRenderer.on('achievements-changed', () => callback());
  },

  // Streaks
  getStreaks: () => ipcRenderer.invoke('get-streaks'),

  // Recommendations
  getRecommendations: () => ipcRenderer.invoke('get-recommendations'),

  // Shareable card
  getShareCard: () => ipcRenderer.invoke('get-share-card'),

  // Updates
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, info) => callback(info));
  },
  installUpdate: () => ipcRenderer.send('install-update'),

  onLeaderboardChanged: (callback) => {
    ipcRenderer.on('leaderboard-changed', () => callback());
  },

  // Dev mode
  getDevMode: () => ipcRenderer.invoke('get-dev-mode'),
  devGetAllEntries: () => ipcRenderer.invoke('dev-get-all-entries'),
  devDeleteEntry: (docId) => ipcRenderer.invoke('dev-delete-entry', docId),
  devDeleteByUsername: (name) => ipcRenderer.invoke('dev-delete-by-username', name),
  devBanUsername: (name) => ipcRenderer.invoke('dev-ban-username', name),
  devUnbanUsername: (name) => ipcRenderer.invoke('dev-unban-username', name),
  devListBanned: () => ipcRenderer.invoke('dev-list-banned'),
  devGetState: () => ipcRenderer.invoke('dev-get-state'),
  devGetRecentErrors: () => ipcRenderer.invoke('dev-get-recent-errors'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  onSettingChanged: (callback) => {
    ipcRenderer.on('setting-changed', (_event, data) => callback(data));
  },

  // Owner mode
  getOwnerMode: () => ipcRenderer.invoke('get-owner-mode'),
  disableDevPasscode: () => ipcRenderer.invoke('disable-dev-passcode'),
  getDevPasscodeStatus: () => ipcRenderer.invoke('get-dev-passcode-status'),
  sendOwnerNotification: (title, body) => ipcRenderer.invoke('send-owner-notification', { title, body }),
});
