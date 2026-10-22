const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qvac', Object.freeze({
  listModels: () => ipcRenderer.invoke('catalog:list'),
  chooseLocal: () => ipcRenderer.invoke('model:choose'),
  download: id => ipcRenderer.invoke('model:download', id),
  pauseDownload: () => ipcRenderer.invoke('model:pause'),
  compare: request => ipcRenderer.invoke('comparison:start', request),
  stop: () => ipcRenderer.invoke('comparison:stop'),
  subscribe: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('compare:event', handler);
    return () => ipcRenderer.removeListener('compare:event', handler);
  }
}));
