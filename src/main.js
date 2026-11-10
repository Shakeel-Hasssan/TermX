'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, Menu, net } = require('electron');
const path = require('path');
const posix = path.posix;
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const pty = require('@lydell/node-pty');
const { Client } = require('ssh2');
const importers = require('./importers');

if (process.env.TERMX_PROFILE) app.setPath('userData', process.env.TERMX_PROFILE);
if (process.env.TERMX_CAPTURE) {
  // Keep painting even when the capture window is hidden behind other windows.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
let win = null;
const terms = new Map(); // termId -> handle
let nextId = 1;

// ---------- persistence ----------
const dataFile = (name) => path.join(app.getPath('userData'), name);
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
function writeJson(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
}
// On Linux without a keyring (GNOME Keyring, KWallet) Electron falls back to a fixed built-in key,
// which anyone could undo, so treat that as having no secure storage and don't save passwords.
const canEncrypt = () => safeStorage.isEncryptionAvailable()
  && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
const encrypt = (s) => (s && canEncrypt() ? safeStorage.encryptString(s).toString('base64') : '');
function decrypt(s) {
  if (!s) return '';
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
}

const loadSessions = () => readJson('sessions.json', []);
const saveSessions = (list) => writeJson('sessions.json', list);
function publicSession(s) {
  const { password, passphrase, ...rest } = s;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

// ---------- output batching ----------
const outBuf = new Map();
let flushTimer = null;
let lastFlush = 0;
// Flow control: pause a shell when the renderer falls this far behind, resume once it catches up.
const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); clearImmediate(flushTimer); }
  flushTimer = null;
  lastFlush = Date.now();
  for (const [id, data] of outBuf) send('term:data', id, data);
  outBuf.clear();
}
function push(id, data) {
  if (!data) return;
  outBuf.set(id, (outBuf.get(id) || '') + data);
  const h = terms.get(id);
  if (h) {
    h.unacked = (h.unacked || 0) + data.length;
    if (!h.paused && h.unacked > HIGH_WATER) { h.paused = true; pauseOutput(h); }
  }
  // Keystroke echo after a quiet spell goes out on the next tick; bursts coalesce for 4ms.
  if (!flushTimer) flushTimer = Date.now() - lastFlush > 16 ? setImmediate(flush) : setTimeout(flush, 4);
}
function pauseOutput(h) {
  try { if (h.kind === 'pty') h.proc.pause(); else h.stream?.pause(); } catch {}
}
function resumeOutput(h) {
  try { if (h.kind === 'pty') h.proc.resume(); else h.stream?.resume(); } catch {}
}
function closed(id, code) {
  const h = terms.get(id);
  if (!h) return;
  terms.delete(id);
  if (h.statsTimer) clearTimeout(h.statsTimer);
  for (const w of h.watchers || []) w.close();
  flush();
  send('term:exit', id, code ?? 0);
}

// ---------- local shells ----------
const run = (file, args, encoding) => new Promise((resolve) => {
  execFile(file, args, { encoding, windowsHide: true, timeout: 4000 }, (err, out) => resolve(err ? '' : out));
});
const where = async (cmd) => (await run('where', [cmd], 'utf8')).split(/\r?\n/)[0].trim() || null;
let shellCache = null;
// Detection runs once, in parallel, starting at launch so the first window doesn't wait on it.
function detectShells() {
  return (shellCache ||= findShells());
}
async function findShells() {
  const list = [];
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    list.push({ id: 'default', name: path.basename(sh), file: sh, args: ['-l'], kind: 'bash' });
    return list;
  }
  const [pwsh, wslOut] = await Promise.all([where('pwsh.exe'), run('wsl.exe', ['-l', '-q'], 'utf16le')]);
  if (pwsh) list.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'], kind: 'pwsh' });
  list.push({ id: 'powershell', name: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'], kind: 'powershell' });
  list.push({ id: 'cmd', name: 'Command Prompt', file: process.env.ComSpec || 'cmd.exe', args: [], kind: 'cmd' });

  const gitCandidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  let gitBash = gitCandidates.find((p) => p && fs.existsSync(p));
  if (!gitBash) {
    const git = await where('git.exe');
    const p = git && path.resolve(path.dirname(git), '..', 'bin', 'bash.exe');
    if (p && fs.existsSync(p)) gitBash = p;
  }
  if (gitBash) list.push({ id: 'gitbash', name: 'Git Bash', file: gitBash, args: ['--login', '-i'], kind: 'bash' });

  {
    wslOut.replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .filter((d) => !/^docker-desktop/i.test(d))
      .forEach((d) => list.push({ id: 'wsl:' + d, name: d, file: 'wsl.exe', args: ['-d', d, '--cd', '~'], kind: 'wsl' }));
  }
  return list;
}
detectShells();

ipcMain.handle('shells:list', async () => (await detectShells()).map(({ id, name, kind }) => ({ id, name, kind })));

ipcMain.handle('term:local', async (_e, { shellId, cols, rows }) => {
  const shells = await detectShells();
  const sh = shells.find((s) => s.id === shellId) || shells[0];
  const id = nextId++;
  const proc = pty.spawn(sh.file, sh.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TermX' },
  });
  proc.onData((d) => push(id, d));
  proc.onExit(({ exitCode }) => closed(id, exitCode));
  terms.set(id, { kind: 'pty', proc });
  return { id, title: sh.name };
});

// ---------- SSH ----------
function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}
function verifyHost(host, port, key, verify) {
  const known = readJson('known_hosts.json', {});
  const entry = `${host}:${port}`;
  const fp = fingerprint(key);
  if (known[entry] === fp) return verify(true);
  const changed = !!known[entry];
  dialog.showMessageBox(win, {
    type: changed ? 'warning' : 'question',
    title: changed ? 'Host key changed!' : 'Unknown host',
    message: changed
      ? `WARNING: the host key for ${entry} has changed.\nThis could mean someone is intercepting the connection.`
      : `The authenticity of ${entry} can't be established.`,
    detail: `Key fingerprint:\n${fp}${changed ? `\n\nPreviously trusted:\n${known[entry]}` : ''}\n\nTrust this host and continue?`,
    buttons: ['Trust & connect', 'Cancel'],
    defaultId: changed ? 1 : 0,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) { known[entry] = fp; writeJson('known_hosts.json', known); }
    verify(response === 0);
  });
}

function defaultKeys() {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((k) => path.join(os.homedir(), '.ssh', k))
    .filter((p) => fs.existsSync(p));
}
// The agent to use, or null when none is running. Pointing ssh2 at a missing agent fails the
// whole connection, so "auto" sign-in has to skip it rather than try it.
function agentPath() {
  if (process.platform === 'win32') {
    // fs.existsSync can't see named pipes; listing the pipe namespace can.
    try { return fs.readdirSync('\\\\.\\pipe\\').includes('openssh-ssh-agent') ? '\\\\.\\pipe\\openssh-ssh-agent' : null; } catch { return null; }
  }
  const sock = process.env.SSH_AUTH_SOCK;
  return sock && fs.existsSync(sock) ? sock : null;
}

ipcMain.handle('term:ssh', (_e, { sessionId, config, password, passphrase, cols, rows }) => {
  let s = config;
  if (sessionId) {
    const list = loadSessions();
    const found = list.find((x) => x.id === sessionId);
    if (!found) throw new Error('Session not found');
    found.lastUsed = Date.now();
    saveSessions(list);
    s = { ...found, password: decrypt(found.password), passphrase: decrypt(found.passphrase) };
  }
  const pw = password || s.password || '';
  const port = Number(s.port) || 22;
  const id = nextId++;
  const conn = new Client();
  const handle = { kind: 'ssh', conn, stream: null, sftp: null, watchers: [] };

  const opts = {
    host: s.host, port, username: s.username,
    readyTimeout: 60000, tryKeyboard: true,
    // A slow or flaky link can stall for a minute or more; only give up after ~5 minutes of silence.
    keepaliveInterval: 30000, keepaliveCountMax: 10,
    // Prefer compression (like MobaXterm/PuTTY): big output arrives much faster on thin links.
    algorithms: { compress: ['zlib@openssh.com', 'zlib', 'none'] },
    hostVerifier: (key, verify) => { verifyHost(s.host, port, key, verify); },
  };
  if (pw) opts.password = pw;
  const keyPass = passphrase || s.passphrase || undefined;
  if (s.auth === 'key') {
    const keyFile = s.keyPath || defaultKeys()[0];
    if (!keyFile) throw new Error('No private key file found');
    opts.privateKey = fs.readFileSync(keyFile);
    opts.passphrase = keyPass;
  } else if (s.auth === 'agent') {
    opts.agent = agentPath();
    if (!opts.agent) {
      throw new Error(process.platform === 'win32'
        ? 'The SSH agent isn\'t running. Start the "OpenSSH Authentication Agent" service, or use a password or key.'
        : 'No SSH agent found (SSH_AUTH_SOCK is not set).');
    }
  } else if (s.auth === 'auto') {
    const k = defaultKeys()[0];
    if (k) { opts.privateKey = fs.readFileSync(k); opts.passphrase = keyPass; }
    const agent = agentPath();
    if (agent) opts.agent = agent;
  }

  terms.set(id, handle);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      terms.delete(id);
      try { conn.end(); } catch {}
      reject(err);
    };
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
    // ssh2 leaves Nagle's algorithm on, which holds each keystroke until the previous packet is
    // acknowledged: on a high-latency link typing turns choppy. Interactive SSH clients turn it off.
    conn.on('connect', () => { try { conn.setNoDelay(true); } catch {} });
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) return fail(err);
        handle.stream = stream;
        const dec = new StringDecoder('utf8');
        const decErr = new StringDecoder('utf8');
        stream.on('data', (d) => push(id, dec.write(d)));
        stream.stderr.on('data', (d) => push(id, decErr.write(d)));
        stream.on('close', () => { try { conn.end(); } catch {} });
        settled = true;
        resolve({ id, title: s.name || `${s.username}@${s.host}` });
        // Warm up the SFTP channel so the file browser opens instantly, but let the shell's first
        // screen arrive before it competes for a slow link. Opening the panel sooner starts it on demand.
        setTimeout(() => { if (terms.get(id) === handle) getSftp(id).catch(() => {}); }, 2000);
        setTimeout(() => startStats(id), 3000);
      });
    });
    conn.on('error', (err) => {
      if (!settled) return fail(err);
      push(id, `\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
    });
    conn.on('close', () => {
      if (!settled) return fail(new Error('Connection closed'));
      closed(id, 0);
    });
    try { conn.connect(opts); } catch (err) { fail(err); }
  });
});

function execOut(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve(out));
    });
  });
}
const STATS_CMD = [
  'cat /proc/loadavg',
  'nproc',
  "free -b | awk '/^Mem:/{print $2, ($7 ? $2-$7 : $3)}'",
  "df -Pk / | awk 'NR==2{print $2*1024, $3*1024}'",
  'cut -d" " -f1 /proc/uptime',
].join(' 2>/dev/null; echo @@; ') + ' 2>/dev/null';

// Poll server stats one request at a time: the next poll is scheduled only after the previous one
// answers, so on a slow link polls never pile up and crowd out typing or hit the server's MaxSessions.
const STATS_EVERY = 10000;
function startStats(id) {
  const h = terms.get(id);
  if (!h || h.kind !== 'ssh') return;
  const tick = async () => {
    h.statsTimer = null;
    try {
      const parts = (await execOut(h.conn, STATS_CMD)).split('@@').map((x) => x.trim());
      if (!parts[0]) throw new Error('unsupported');
      const [mt, mu] = (parts[2] || '').split(/\s+/).map(Number);
      const [dt, du] = (parts[3] || '').split(/\s+/).map(Number);
      send('ssh:stats', id, {
        load: Number(parts[0].split(/\s+/)[0]),
        cpus: Number(parts[1]) || 1,
        memTotal: mt || 0, memUsed: mu || 0,
        diskTotal: dt || 0, diskUsed: du || 0,
        uptime: Number(parts[4]) || 0,
      });
    } catch {
      return; // unsupported server or channel refused: stop polling
    }
    if (terms.get(id) === h) h.statsTimer = setTimeout(tick, STATS_EVERY);
  };
  tick();
}

// ---------- terminal I/O ----------
ipcMain.on('term:write', (_e, id, data) => {
  const h = terms.get(id);
  if (!h) return;
  if (h.kind === 'pty') h.proc.write(data);
  else if (h.stream) h.stream.write(data);
});
ipcMain.on('term:ack', (_e, id, n) => {
  const h = terms.get(id);
  if (!h) return;
  h.unacked = Math.max(0, (h.unacked || 0) - n);
  if (h.paused && h.unacked < LOW_WATER) { h.paused = false; resumeOutput(h); }
});
ipcMain.on('term:resize', (_e, id, cols, rows) => {
  const h = terms.get(id);
  if (!h || !cols || !rows) return;
  try {
    if (h.kind === 'pty') h.proc.resize(cols, rows);
    else if (h.stream) h.stream.setWindow(rows, cols, 0, 0);
  } catch {}
});
ipcMain.on('term:kill', (_e, id) => {
  const h = terms.get(id);
  if (!h) return;
  try {
    if (h.kind === 'pty') h.proc.kill();
    else h.conn.end();
  } catch {}
  closed(id, 0);
});

// ---------- SFTP ----------
const P = (fn, ...args) => new Promise((res, rej) => fn(...args, (err, r) => (err ? rej(err) : res(r))));
function getSftp(id) {
  const h = terms.get(id);
  if (!h || h.kind !== 'ssh') return Promise.reject(new Error('Not an SSH session'));
  if (!h.sftp) {
    h.sftp = new Promise((res, rej) => h.conn.sftp((err, sftp) => (err ? rej(err) : res(sftp))));
    h.sftp.catch(() => { h.sftp = null; });
  }
  return h.sftp;
}
let transferSeq = 1;
function progressFn(name, kind) {
  const tid = transferSeq++;
  let last = 0;
  return {
    tid,
    step: (done, _chunk, total) => {
      const now = Date.now();
      if (now - last > 120 || done === total) { last = now; send('sftp:progress', { tid, name, kind, done, total }); }
    },
    end: (error) => send('sftp:progress', { tid, name, kind, finished: true, error: error ? String(error.message || error) : null }),
  };
}

ipcMain.handle('sftp:home', async (_e, id) => {
  const sftp = await getSftp(id);
  return P(sftp.realpath.bind(sftp), '.');
});

ipcMain.handle('sftp:list', async (_e, id, dir) => {
  const sftp = await getSftp(id);
  const real = await P(sftp.realpath.bind(sftp), dir || '.');
  const entries = await P(sftp.readdir.bind(sftp), real);
  const items = await Promise.all(entries.map(async (e) => {
    const a = e.attrs;
    let isDir = a.isDirectory();
    const isLink = a.isSymbolicLink();
    if (isLink) {
      try { isDir = (await P(sftp.stat.bind(sftp), posix.join(real, e.filename))).isDirectory(); } catch {}
    }
    return { name: e.filename, size: a.size, mtime: a.mtime * 1000, mode: a.mode, isDir, isLink };
  }));
  items.sort((x, y) => (x.isDir === y.isDir ? x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) : x.isDir ? -1 : 1));
  return { path: real, items };
});

// Folder transfers: create the directory tree first, then move up to 4 files at once
// with one progress bar for the whole folder.
const FILE_CONCURRENCY = 4;
async function transferFiles(files, move, prog) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const done = new Map();
  let sum = 0;
  const step = (f) => (bytes) => {
    sum += bytes - (done.get(f) || 0);
    done.set(f, bytes);
    prog.step(sum, 0, total);
  };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      await move(f, step(f));
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, files.length) }, worker));
}
async function downloadRec(sftp, remote, local, prog) {
  const files = [];
  const walk = async (r, l) => {
    const st = await P(sftp.stat.bind(sftp), r);
    if (!st.isDirectory()) return files.push({ r, l, size: st.size });
    fs.mkdirSync(l, { recursive: true });
    const entries = await P(sftp.readdir.bind(sftp), r);
    await Promise.all(entries.map((e) => walk(posix.join(r, e.filename), path.join(l, e.filename))));
  };
  await walk(remote, local);
  await transferFiles(files, (f, step) => P(sftp.fastGet.bind(sftp), f.r, f.l, { step }), prog);
}
async function uploadRec(sftp, local, remote, prog) {
  const files = [];
  const walk = async (l, r) => {
    const st = fs.statSync(l);
    if (!st.isDirectory()) return files.push({ l, r, size: st.size });
    try { await P(sftp.mkdir.bind(sftp), r); } catch {}
    for (const name of fs.readdirSync(l)) await walk(path.join(l, name), posix.join(r, name));
  };
  await walk(local, remote);
  await transferFiles(files, (f, step) => P(sftp.fastPut.bind(sftp), f.l, f.r, { step }), prog);
}
async function removeRec(sftp, p) {
  const st = await P(sftp.lstat.bind(sftp), p);
  if (st.isDirectory()) {
    for (const e of await P(sftp.readdir.bind(sftp), p)) await removeRec(sftp, posix.join(p, e.filename));
    await P(sftp.rmdir.bind(sftp), p);
  } else {
    await P(sftp.unlink.bind(sftp), p);
  }
}

ipcMain.handle('sftp:download', async (_e, id, remotePaths) => {
  const sftp = await getSftp(id);
  let targetDir;
  if (remotePaths.length === 1) {
    const st = await P(sftp.stat.bind(sftp), remotePaths[0]);
    if (!st.isDirectory()) {
      const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), posix.basename(remotePaths[0])) });
      if (r.canceled) return false;
      const prog = progressFn(posix.basename(remotePaths[0]), 'download');
      try { await P(sftp.fastGet.bind(sftp), remotePaths[0], r.filePath, { step: prog.step }); prog.end(); }
      catch (err) { prog.end(err); throw err; }
      return true;
    }
  }
  const r = await dialog.showOpenDialog(win, { title: 'Download to folder', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return false;
  targetDir = r.filePaths[0];
  for (const rp of remotePaths) {
    const prog = progressFn(posix.basename(rp), 'download');
    try { await downloadRec(sftp, rp, path.join(targetDir, posix.basename(rp)), prog); prog.end(); }
    catch (err) { prog.end(err); throw err; }
  }
  return true;
});

ipcMain.handle('sftp:upload', async (_e, id, remoteDir, localPaths) => {
  const sftp = await getSftp(id);
  if (!localPaths || !localPaths.length) {
    const r = await dialog.showOpenDialog(win, { title: 'Upload files', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return false;
    localPaths = r.filePaths;
  }
  for (const lp of localPaths) {
    const prog = progressFn(path.basename(lp), 'upload');
    try { await uploadRec(sftp, lp, posix.join(remoteDir, path.basename(lp)), prog); prog.end(); }
    catch (err) { prog.end(err); throw err; }
  }
  return true;
});

ipcMain.handle('sftp:mkdir', async (_e, id, p) => { const s = await getSftp(id); await P(s.mkdir.bind(s), p); });
ipcMain.handle('sftp:touch', async (_e, id, p) => {
  const s = await getSftp(id);
  const h = await P(s.open.bind(s), p, 'a');
  await P(s.close.bind(s), h);
});
ipcMain.handle('sftp:rename', async (_e, id, from, to) => { const s = await getSftp(id); await P(s.rename.bind(s), from, to); });
ipcMain.handle('sftp:delete', async (_e, id, paths) => {
  const s = await getSftp(id);
  for (const p of paths) await removeRec(s, p);
});

// Open a remote file in the default local app; re-upload whenever it's saved.
ipcMain.handle('sftp:open', async (_e, id, remote) => {
  const sftp = await getSftp(id);
  const h = terms.get(id);
  const dir = path.join(os.tmpdir(), 'termx', crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, posix.basename(remote));
  await P(sftp.fastGet.bind(sftp), remote, local);
  let timer = null;
  let lastMtime = fs.statSync(local).mtimeMs;
  const watcher = fs.watch(local, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const m = fs.statSync(local).mtimeMs;
        if (m === lastMtime) return;
        lastMtime = m;
        await P(sftp.fastPut.bind(sftp), local, remote);
        send('sftp:synced', { id, remote, ok: true });
      } catch (err) {
        send('sftp:synced', { id, remote, ok: false, error: err.message });
      }
    }, 400);
  });
  h.watchers.push(watcher);
  const err = await shell.openPath(local);
  if (err) throw new Error(err);
  return local;
});

// ---------- sessions ----------
ipcMain.handle('sessions:list', () => loadSessions().map(publicSession));
ipcMain.handle('sessions:save', (_e, input) => {
  const list = loadSessions();
  const idx = list.findIndex((x) => x.id === input.id);
  const prev = idx >= 0 ? list[idx] : {};
  const { password, passphrase, savePassword, ...fields } = input;
  const s = { ...prev, ...fields, id: input.id || crypto.randomUUID(), created: prev.created || Date.now() };
  if (password !== undefined) s.password = savePassword ? encrypt(password) : '';
  if (passphrase !== undefined) s.passphrase = savePassword ? encrypt(passphrase) : '';
  if (idx >= 0) list[idx] = s; else list.push(s);
  saveSessions(list);
  return publicSession(s);
});
ipcMain.handle('sessions:delete', (_e, id) => saveSessions(loadSessions().filter((x) => x.id !== id)));
ipcMain.handle('sessions:deleteMany', (_e, ids) => { const drop = new Set(ids); saveSessions(loadSessions().filter((x) => !drop.has(x.id))); });
// Moves sessions between folders in one write: changes is [{ id, folder }].
ipcMain.handle('sessions:setFolders', (_e, changes) => {
  const byId = new Map(changes.map((c) => [c.id, String(c.folder || '')]));
  saveSessions(loadSessions().map((s) => (byId.has(s.id) ? { ...s, folder: byId.get(s.id) } : s)));
});
// Folders that exist on their own, so an empty folder survives until it is deleted.
ipcMain.handle('folders:list', () => readJson('folders.json', []));
ipcMain.handle('folders:save', (_e, list) => writeJson('folders.json', Array.isArray(list) ? list.map(String) : []));
// Folder path -> color; folders without an entry keep the default yellow.
ipcMain.handle('folders:colors', () => readJson('folder-colors.json', {}));
ipcMain.handle('folders:saveColors', (_e, map) => {
  const clean = {};
  for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) if (/^#[0-9a-f]{6}$/i.test(v)) clean[String(k)] = v.toLowerCase();
  writeJson('folder-colors.json', clean);
});
ipcMain.handle('sessions:forgetPassword', (_e, id) => {
  const list = loadSessions();
  const s = list.find((x) => x.id === id);
  if (s) { s.password = ''; s.passphrase = ''; saveSessions(list); }
});

// ---------- import / export ----------
ipcMain.handle('import:scan', () => importers.scan());
ipcMain.handle('import:file', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import connections',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [
      { name: 'Session files', extensions: ['mxtsessions', 'ini', 'reg', 'json', 'conf', 'config', '*'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return { ...importers.parseFile(r.filePaths[0]), path: r.filePaths[0] }; } catch (err) { return { error: err.message, path: r.filePaths[0] }; }
});
ipcMain.handle('sessions:import', (_e, items) => {
  const list = loadSessions();
  const added = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it?.host) continue;
    const s = { name: String(it.name || it.host), host: String(it.host), port: Number(it.port) || 22, username: String(it.username || ''),
      auth: ['password', 'key', 'agent', 'auto'].includes(it.auth) ? it.auth : 'auto', keyPath: String(it.keyPath || ''), folder: String(it.folder || ''),
      color: it.color || '', id: crypto.randomUUID(), created: Date.now(), password: '', passphrase: '' };
    list.push(s);
    added.push(publicSession(s));
  }
  saveSessions(list);
  return added;
});
// Exports never include passwords: they are encrypted for this Windows account and useless elsewhere.
ipcMain.handle('sessions:export', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Export sessions', defaultPath: path.join(app.getPath('documents'), 'TermX-sessions.json'), filters: [{ name: 'TermX sessions', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  const sessions = loadSessions().map(({ name, host, port, username, auth, keyPath, folder, color }) => ({ name, host, port, username, auth, keyPath, folder, color }));
  fs.writeFileSync(r.filePath, JSON.stringify({ app: 'TermX', version: 1, exported: new Date().toISOString(), sessions }, null, 2));
  return { path: r.filePath, count: sessions.length };
});

// ---------- flows ----------
ipcMain.handle('flows:list', () => readJson('flows.json', []));
ipcMain.handle('flows:save', (_e, list) => writeJson('flows.json', Array.isArray(list) ? list : []));

// ---------- misc ----------
ipcMain.handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select private key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('app:info', () => ({
  platform: process.platform,
  build: Number(os.release().split('.')[2]) || 0,
  version: app.getVersion(),
  canEncrypt: canEncrypt(),
}));
ipcMain.on('app:devtools', () => win && win.webContents.toggleDevTools());
ipcMain.on('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });

// ---------- updates ----------
// Releases come from GitHub; each platform takes the installer that matches how TermX was installed.
const RELEASES = 'https://api.github.com/repos/Shakeel-Hasssan/TermX/releases/latest';
const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(Number);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
// How this copy was installed decides which file to download and how to swap it in.
function installKind() {
  if (!app.isPackaged) return 'source';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  if (process.platform === 'darwin') return 'dmg';
  return process.env.APPIMAGE ? 'appimage' : 'deb';
}
const ASSETS = {
  nsis: 'TermX-Setup-x64.exe',
  portable: 'TermX-Portable-x64.exe',
  dmg: `TermX-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`,
  appimage: 'TermX-linux-x86_64.AppImage',
  deb: 'TermX-linux-amd64.deb',
};
let update = null; // latest check result, reused by update:install

ipcMain.handle('update:check', async () => {
  const res = await net.fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TermX' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = await res.json();
  const kind = installKind();
  const asset = (rel.assets || []).find((a) => a.name === ASSETS[kind]);
  update = {
    current: app.getVersion(),
    latest: String(rel.tag_name || '').replace(/^v/, ''),
    page: rel.html_url,
    kind,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
  };
  update.available = newer(update.latest, update.current);
  return update;
});

async function download(asset) {
  const dir = path.join(app.getPath('temp'), 'termx-update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  const res = await net.fetch(asset.url, { headers: { 'User-Agent': 'TermX' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const out = fs.createWriteStream(file);
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 150) { last = Date.now(); win?.webContents.send('update:progress', got, asset.size); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (asset.size && got !== asset.size) throw new Error('Download was incomplete, please try again');
  win?.webContents.send('update:progress', got, asset.size);
  return file;
}

// A detached script waits for this process to exit, swaps the new build in and starts it.
function runAfterExit(script, ext) {
  const file = path.join(app.getPath('temp'), 'termx-update', 'apply' + ext);
  fs.writeFileSync(file, script);
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/c', file], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [file], { detached: true, stdio: 'ignore' });
  child.unref();
}
const sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

ipcMain.handle('update:install', async () => {
  if (!update?.available) throw new Error('No update to install');
  if (update.kind === 'source') throw new Error('TermX is running from source; pull the latest code instead');
  if (!update.asset) throw new Error(`This release has no ${ASSETS[update.kind]}`);
  const file = await download(update.asset);
  const pid = process.pid;

  if (update.kind === 'nsis') {
    // The installer upgrades in place silently, then --force-run starts the new version.
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  } else if (update.kind === 'portable') {
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    // The portable launcher keeps its exe locked until it exits, so keep retrying the copy.
    runAfterExit([
      '@echo off', 'set n=0', ':retry',
      `copy /y "${file}" "${target}" >nul 2>&1 && goto done`,
      'set /a n+=1', 'if %n% geq 60 exit /b 1', 'timeout /t 1 /nobreak >nul', 'goto retry',
      ':done', `start "" "${target}"`, `del "${file}"`, '(goto) 2>nul & del "%~f0"',
    ].join('\r\n'), '.cmd');
  } else if (update.kind === 'dmg') {
    const target = path.resolve(process.execPath, '..', '..', '..');
    if (!target.endsWith('.app')) throw new Error('Could not find the TermX app bundle');
    // Not writable (e.g. still running from the disk image): open the .dmg and let the user drag it.
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch {
      shell.openPath(file);
      return { manual: true };
    }
    const old = target + '.old';
    runAfterExit(`
while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d)
hdiutil attach -nobrowse -noautoopen -mountpoint "$MNT" ${sh(file)} >/dev/null || exit 1
APP=$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)
rm -rf ${sh(old)}
if mv ${sh(target)} ${sh(old)} && ditto "$APP" ${sh(target)}; then rm -rf ${sh(old)}; else rm -rf ${sh(target)}; mv ${sh(old)} ${sh(target)}; fi
hdiutil detach "$MNT" -quiet
rm -f ${sh(file)}
xattr -dr com.apple.quarantine ${sh(target)} 2>/dev/null
open ${sh(target)}
`, '.sh');
  } else if (update.kind === 'appimage') {
    const target = process.env.APPIMAGE;
    runAfterExit(`
while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done
cp -f ${sh(file)} ${sh(target)} && chmod +x ${sh(target)} && rm -f ${sh(file)}
nohup ${sh(target)} >/dev/null 2>&1 &
`, '.sh');
  } else {
    // .deb needs root; pkexec asks for the password, otherwise hand the package to the system installer.
    const ok = await new Promise((r) => execFile('pkexec', ['dpkg', '-i', file], (err) => r(!err)));
    if (!ok) { shell.openPath(file); return { manual: true }; }
    runAfterExit(`
while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done
nohup ${sh(process.execPath)} >/dev/null 2>&1 &
`, '.sh');
  }
  setTimeout(() => app.quit(), 300);
  return { manual: false };
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    title: 'TermX',
    icon: ICON,
    backgroundColor: '#0a0d13',
    titleBarStyle: 'hidden',
    // There is no title bar: Windows and Linux draw min/max/close over the 36px tab bar row,
    // and macOS puts its traffic lights at the top of the rail.
    titleBarOverlay: process.platform !== 'darwin' ? { color: '#00000000', symbolColor: '#aab3c2', height: 36 } : undefined,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  // Dev aid: TERMX_CAPTURE=out.png [TERMX_EVAL=js] captures the window and exits.
  if (process.env.TERMX_CAPTURE) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('did-start-loading', () => console.log('[main] page loading'));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[main] renderer gone', d.reason));
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(1500);
      if (process.env.TERMX_EVAL) {
        try { console.log('[eval]', await win.webContents.executeJavaScript(process.env.TERMX_EVAL)); }
        catch (err) { console.log('[eval error]', err.message); }
        await wait(Number(process.env.TERMX_WAIT) || 2500);
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.TERMX_CAPTURE, img.toPNG());
      app.quit();
    });
  }
}

Menu.setApplicationMenu(null);
// Its own taskbar identity on Windows, so TermX doesn't group with other Electron apps.
if (process.platform === 'win32') app.setAppUserModelId('com.termx.app');
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'assets', 'icon-1024.png'));
  createWindow();
});
app.on('window-all-closed', () => {
  for (const id of [...terms.keys()]) {
    const h = terms.get(id);
    try { h.kind === 'pty' ? h.proc.kill() : h.conn.end(); } catch {}
  }
  app.quit();
});
