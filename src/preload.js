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
  onLeaderboardChanged: (callback) => {
    ipcRenderer.on('leaderboard-changed', () => callback());
  },

  // Dev mode (J@R3D) — only functional when devModeActive is true in main
  devGetAllEntries: () => ipcRenderer.invoke('dev-get-all-entries'),
  devDeleteEntry: (docId) => ipcRenderer.invoke('dev-delete-entry', docId),

  // Owner mode (R3D_EYE) — only functional when ownerModeActive is true in main
  ownerGetKillSwitch: () => ipcRenderer.invoke('owner-get-kill-switch'),
  ownerSetKillSwitch: (killed) => ipcRenderer.invoke('owner-set-kill-switch', killed),
});

