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
});
