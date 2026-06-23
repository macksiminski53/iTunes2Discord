// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPlayData: () => ipcRenderer.invoke('get-data'),
  onTrackUpdate: (callback) => ipcRenderer.on('track-update', (event, track) => callback(track)),
  onDataUpdate: (callback) => ipcRenderer.on('data-update', (event, data) => callback(data)),
  onDiscordConnected: (callback) => ipcRenderer.on('discord-connected', () => callback()),
  onDiscordDisconnected: (callback) => ipcRenderer.on('discord-disconnected', () => callback()),
  playTrack: () => ipcRenderer.invoke('play-track'),
  pauseTrack: () => ipcRenderer.invoke('pause-track'),
  nextTrack: () => ipcRenderer.invoke('next-track'),
  previousTrack: () => ipcRenderer.invoke('previous-track'),
});
