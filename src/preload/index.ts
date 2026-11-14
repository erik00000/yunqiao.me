import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aurora', {
  invoke: (action: string, payload?: any) => ipcRenderer.invoke('aurora:invoke', { action, payload }),
  recent: () => ipcRenderer.invoke('aurora:recent'),
  onUsage: (cb: (rec: any) => void) => {
    const h = (_e: any, rec: any) => cb(rec);
    ipcRenderer.on('aurora:usage', h);
    return () => ipcRenderer.removeListener('aurora:usage', h);
  },
  onGateway: (cb: (st: any) => void) => {
    const h = (_e: any, st: any) => cb(st);
    ipcRenderer.on('aurora:gateway', h);
    return () => ipcRenderer.removeListener('aurora:gateway', h);
  },
});
