const { contextBridge, ipcRenderer } = require('electron')

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld('dsApi', {
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  refresh: () => ipcRenderer.invoke('refresh'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  exportData: () => ipcRenderer.invoke('export-data'),
  startUsageSync: () => ipcRenderer.invoke('start-usage-sync'),
  clearPlatformToken: () => ipcRenderer.invoke('clear-platform-token'),
  onTokenSynced: (cb) => ipcRenderer.on('token-synced', (_e, d) => cb(d)),
  setPinned: (v) => ipcRenderer.invoke('set-pinned', v),
  setWindowHeight: (h) => ipcRenderer.invoke('set-window-height', h),
  onPinned: (cb) => ipcRenderer.on('pinned-changed', (_e, d) => cb(d)),
  onOpenSetup: (cb) => ipcRenderer.on('open-setup', () => cb()),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  quitApp: () => ipcRenderer.invoke('quit-app')
})
