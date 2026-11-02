'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const fire = (ch) => (...args) => ipcRenderer.send(ch, ...args);
const EVENTS = ['term:data', 'term:exit', 'ssh:stats', 'sftp:progress', 'sftp:synced'];

contextBridge.exposeInMainWorld('termx', {
  info: invoke('app:info'),
  shells: invoke('shells:list'),
  openLocal: invoke('term:local'),
  openSsh: invoke('term:ssh'),
  write: fire('term:write'),
  resize: fire('term:resize'),
  ack: fire('term:ack'),
  kill: fire('term:kill'),
  sftp: {
    home: invoke('sftp:home'),
    list: invoke('sftp:list'),
    download: invoke('sftp:download'),
    upload: invoke('sftp:upload'),
    mkdir: invoke('sftp:mkdir'),
    touch: invoke('sftp:touch'),
    rename: invoke('sftp:rename'),
    remove: invoke('sftp:delete'),
    open: invoke('sftp:open'),
  },
  sessions: {
    list: invoke('sessions:list'),
    save: invoke('sessions:save'),
    remove: invoke('sessions:delete'),
    forgetPassword: invoke('sessions:forgetPassword'),
    import: invoke('sessions:import'),
    deleteMany: invoke('sessions:deleteMany'),
    setFolders: invoke('sessions:setFolders'),
    export: invoke('sessions:export'),
  },
  folders: {
    list: invoke('folders:list'),
    save: invoke('folders:save'),
  },
  importer: {
    scan: invoke('import:scan'),
    file: invoke('import:file'),
  },
  flows: {
    list: invoke('flows:list'),
    save: invoke('flows:save'),
  },
  pickKey: invoke('dialog:pickKey'),
  clipboardRead: invoke('clipboard:read'),
  clipboardWrite: fire('clipboard:write'),
  devtools: fire('app:devtools'),
  openExternal: fire('app:openExternal'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on(channel, cb) {
    if (!EVENTS.includes(channel)) throw new Error('Unknown channel ' + channel);
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
