// Reads saved connections from other tools and turns them into TermX sessions:
// { name, host, port, username, auth, keyPath, folder }. Passwords are never imported.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const home = os.homedir();
const expandHome = (p) => (p && /^~[\\/]/.test(p) ? path.join(home, p.slice(2)) : p);
const keyAuth = (keyPath) => (keyPath ? { auth: 'key', keyPath } : { auth: 'auto', keyPath: '' });

function session(fields) {
  const port = Number(fields.port) || 22;
  return { name: fields.name || fields.host, host: fields.host, port, username: fields.username || '', folder: fields.folder || '', ...keyAuth(fields.keyPath) };
}

function readText(file) {
  const buf = fs.readFileSync(file);
  // .reg exports from regedit are UTF-16LE with a BOM.
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  const s = buf.toString('utf8');
  return s.replace(/^﻿/, '');
}

// ---------- OpenSSH config ----------
function parseSshConfig(text, folder = 'SSH config') {
  const out = [];
  let cur = null;
  const flush = () => { if (cur?.alias) out.push(session({ name: cur.alias, host: cur.hostname || cur.alias, port: cur.port, username: cur.user, keyPath: expandHome(cur.identityfile), folder })); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)\s*(?:=|\s)\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host' || key === 'match') {
      flush();
      // Wildcard and negated patterns are defaults for other hosts, not connections.
      const alias = key === 'host' ? val.split(/\s+/).find((a) => !/[*?!]/.test(a)) : null;
      cur = { alias };
    } else if (cur && !(key in cur)) cur[key] = val;
  }
  flush();
  return out;
}

// ---------- PuTTY ----------
const puttyName = (s) => decodeURIComponent(s.replace(/%(?![0-9a-f]{2})/gi, '%25'));

function puttyEntry(name, v) {
  if (v.Protocol && v.Protocol !== 'ssh') return null;
  if (!v.HostName || name === 'Default Settings') return null;
  let host = v.HostName, username = v.UserName;
  if (!username && host.includes('@')) [username, host] = [host.slice(0, host.lastIndexOf('@')), host.slice(host.lastIndexOf('@') + 1)];
  return session({ name, host, port: v.PortNumber, username, keyPath: v.PublicKeyFile, folder: 'PuTTY' });
}

// `reg query ... /s` output.
function parsePuttyRegQuery(text) {
  const out = [];
  let name = null, vals = {};
  const flush = () => { if (name) { const s = puttyEntry(name, vals); if (s) out.push(s); } };
  for (const line of text.split(/\r?\n/)) {
    const k = line.match(/\\Sessions\\(.+)$/);
    if (k && /^HKEY_/.test(line)) { flush(); name = puttyName(k[1].trim()); vals = {}; continue; }
    const v = line.match(/^\s+(\S+)\s+(REG_SZ|REG_DWORD)\s*(.*)$/);
    if (v && name) vals[v[1]] = v[2] === 'REG_DWORD' ? parseInt(v[3], 16) : v[3];
  }
  flush();
  return out;
}

// A .reg file exported from regedit.
function parsePuttyReg(text) {
  const out = [];
  let name = null, vals = {};
  const flush = () => { if (name) { const s = puttyEntry(name, vals); if (s) out.push(s); } };
  for (const line of text.split(/\r?\n/)) {
    const k = line.match(/^\[.*\\Sessions\\(.+)\]$/);
    if (k) { flush(); name = puttyName(k[1]); vals = {}; continue; }
    if (/^\[/.test(line)) { flush(); name = null; continue; }
    const v = line.match(/^"([^"]+)"=(?:"((?:[^"\\]|\\.)*)"|dword:([0-9a-f]+))/i);
    if (v && name) vals[v[1]] = v[3] !== undefined ? parseInt(v[3], 16) : v[2].replace(/\\(.)/g, '$1');
  }
  flush();
  return out;
}

function readPuttyRegistry() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', '/s'], { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      resolve(err ? [] : parsePuttyRegQuery(stdout));
    });
  });
}

// ---------- MobaXterm ----------
// Session lines look like:  name= #109#0%host%22%user%...#MobaFont%...
// #109 is SSH; the folder comes from the SubRep= line of the bookmark section.
const mobaUnescape = (s) => s.replace(/__DIEZE__/g, '#').replace(/__PIPE__/g, '|').replace(/__PTVIRG__/g, ';').replace(/__DBLQUO__/g, '"').replace(/__PERCENT__/g, '%');

function mobaPath(p) {
  if (!p) return '';
  p = p.replace(/_ProfileDir_/g, home)
    .replace(/_CurrentDrive_/g, (process.env.SystemDrive || 'C:'))
    .replace(/_MyDocuments_/g, path.join(home, 'Documents'))
    .replace(/_AppDataDir_/g, process.env.APPDATA || path.join(home, 'AppData', 'Roaming'));
  return p.includes('_') && /^_\w+_/.test(p) ? '' : p;
}

function parseMoba(text) {
  const out = [];
  let folder = '';
  let inBookmarks = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { inBookmarks = /^Bookmarks(_\d+)?$/i.test(sec[1]); folder = ''; continue; }
    if (!inBookmarks) continue;
    if (/^SubRep=/i.test(line)) { folder = line.slice(7).replace(/\\/g, ' / '); continue; }
    const m = line.match(/^(.+?)=\s*#(\d+)#(.*)$/);
    if (!m || m[2] !== '109') continue;
    const f = m[3].split('#')[0].split('%');
    const host = mobaUnescape(f[1] || '').trim();
    if (!host) continue;
    const key = f.slice(4).map(mobaUnescape).find((x) => /\.(ppk|pem|key)$|[\\/]id_[a-z0-9]+$/i.test(x));
    out.push(session({ name: mobaUnescape(m[1].trim()), host, port: f[2], username: mobaUnescape(f[3] || ''), keyPath: mobaPath(key), folder: folder ? 'MobaXterm / ' + folder : 'MobaXterm' }));
  }
  return out;
}

function mobaIniCandidates() {
  if (process.platform !== 'win32') return [];
  const docs = path.join(home, 'Documents', 'MobaXterm');
  return [
    path.join(process.env.APPDATA || '', 'MobaXterm', 'MobaXterm.ini'),
    path.join(docs, 'MobaXterm.ini'),
    path.join(home, 'OneDrive', 'Documents', 'MobaXterm', 'MobaXterm.ini'),
  ];
}

// ---------- TermX export ----------
function parseTermx(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.sessions;
  if (!Array.isArray(list)) throw new Error('No sessions in this file');
  return list.filter((s) => s && s.host).map((s) => ({ ...session(s), auth: s.auth || 'auto', keyPath: s.keyPath || '', color: s.color, name: s.name || s.host }));
}

// ---------- entry points ----------
const SOURCES = { ssh: 'OpenSSH config', putty: 'PuTTY', moba: 'MobaXterm', termx: 'TermX export' };

function parseFile(file) {
  const text = readText(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mxtsessions' || /^\[Bookmarks(_\d+)?\]/im.test(text)) return { source: 'moba', sessions: parseMoba(text) };
  if (ext === '.reg' || /SimonTatham\\PuTTY/i.test(text)) return { source: 'putty', sessions: parsePuttyReg(text) };
  if (ext === '.json' || /^\s*[[{]/.test(text)) return { source: 'termx', sessions: parseTermx(text) };
  if (/^\s*host\s/im.test(text)) return { source: 'ssh', sessions: parseSshConfig(text) };
  throw new Error('This file doesn\'t look like MobaXterm, PuTTY, OpenSSH or TermX sessions');
}

// Connections already on this computer, from every tool we know about.
async function scan() {
  const found = [];
  const sshConfig = path.join(home, '.ssh', 'config');
  if (fs.existsSync(sshConfig)) {
    try { found.push({ source: 'ssh', path: sshConfig, sessions: parseSshConfig(readText(sshConfig)) }); } catch {}
  }
  const putty = await readPuttyRegistry();
  if (putty.length) found.push({ source: 'putty', path: 'Windows registry', sessions: putty });
  const ini = mobaIniCandidates().find((p) => fs.existsSync(p));
  if (ini) {
    try { found.push({ source: 'moba', path: ini, sessions: parseMoba(readText(ini)) }); } catch {}
  }
  return found.filter((f) => f.sessions.length);
}

module.exports = { SOURCES, scan, parseFile, parseSshConfig, parseMoba, parsePuttyReg, parsePuttyRegQuery, parseTermx };
