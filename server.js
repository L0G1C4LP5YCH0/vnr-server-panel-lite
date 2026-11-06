'use strict';
/*
 * VNR SERVER LAUNCHER  --  local launcher / dashboard for the ChoomVille server.
 * One file, no npm packages. Needs only Node 18+ (already on this PC).
 *
 *   node server.js            start the launcher (opens your browser)
 *   node server.js --no-open  start without opening the browser
 *
 * Start / stop / restart, live log, backups (config, database, scripts), automatic restart after a crash,
 * a daily restart, scheduled backups, the boot load list of server.jsonc, and a change log of everything
 * that happens (who/what/when) in logs/changes.jsonl.
 *
 * It binds to 127.0.0.1 only, and every request needs the per-run cookie it hands to the page it opens.
 * What the buttons do is defined in dashboard.json (next to this file). Add a button there, reload the page.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const ROOT = __dirname;
const CFG_PATH = process.env.CV_DASH_CONFIG || path.join(ROOT, 'dashboard.json');
const STATE_PATH = path.join(path.dirname(CFG_PATH), 'state.json');
const NO_OPEN = process.argv.includes('--no-open') || process.env.CV_DASH_NO_OPEN === '1';

// ------------------------------------------------------------------ config
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
// VPS buttons come from vps.js when dashboard.json has none of its own (an old dashboard.json keeps working unchanged)
let VPS_BUTTONS = [];
try { VPS_BUTTONS = require('./vps.js').BUTTONS || []; } catch (_) { /* vps.js missing: the launcher works as before */ }
const withVps = (c) => { if (VPS_BUTTONS.length && !(c.buttons || []).some((b) => /^vps\./.test(b.run || ''))) c.buttons = (c.buttons || []).concat(VPS_BUTTONS); return c; };
// ---------------------------------------------------------------- product + settings page
const PRODUCT = { name: 'VNR - CyberPunk Server Panel Lite', brand: 'VNR Network Online', site: 'https://vnrnetwork.online', siteShort: 'vnrnetwork.online', contact: 'virtualnexusroads@gmail.com', build: '2026.11.06' };
const SETTINGS_DEF = [
  { g: 'server', k: 'serverDir', label: 'Server folder', type: 'dir', def: '../server', hint: 'The folder that holds your server program. Relative to this launcher folder, or a full path such as D:\\GameServer.' },
  { g: 'server', k: 'server.exe', label: 'Server program', type: 'file', def: 'Open77.Server.exe', hint: 'The server program inside the server folder.' },
  { g: 'server', k: 'server.startBat', label: 'Start script', type: 'file', opt: true, def: '', hint: 'A .bat that starts your server. Leave empty to start the server program directly.' },
  { g: 'server', k: 'server.config', label: 'Server config file', type: 'file', def: 'server.jsonc', hint: 'The config file the server reads (server name, mods, network).' },
  { g: 'server', k: 'server.log', label: 'Server log file', type: 'file', def: 'logs/server-latest.log', hint: 'Where the server writes its log (used by the Console, Crashes and Monitor pages).' },
  { g: 'server', k: 'server.resourcesRoot', label: 'Resources folder', type: 'file', def: 'resources', hint: 'The folder with your server resources, inside the server folder.' },
  { g: 'server', k: 'server.ports.game', label: 'Game port (UDP)', type: 'port', def: 11778, hidden: true, hint: 'Set on the Server page.' },
  { g: 'server', k: 'server.ports.download', label: 'Download port', type: 'port', def: 11779, hint: 'The port players download resources from.' },
  { g: 'server', k: 'server.ports.warden', label: 'Admin panel port', type: 'port', def: 11780, hint: 'The port of the server admin panel.' },
  { g: 'server', k: 'server.dbPort', label: 'Database port', type: 'port', def: 3306, hint: 'The MariaDB / MySQL port.' },
  { g: 'server', k: 'server.stopWaitSeconds', label: 'Wait on stop (seconds)', type: 'int', min: 1, max: 300, def: 12, hint: 'How long a stop waits for the server to close by itself before it is forced.' },
  { g: 'backups', k: 'backups.dir', label: 'Backup folder', type: 'dirrel', def: 'backups', hint: 'Where backups are kept, relative to the launcher folder (or a full path).' },
  { g: 'backups', k: 'backups.scriptsDir', label: 'Your scripts folder', type: 'file', def: 'scripts', hint: 'The folder inside Resources that holds scripts you wrote yourself. It is backed up as "scripts".' },
  { g: 'backups', k: 'backups.keep', label: 'Config backups to keep', type: 'int', min: 1, max: 500, def: 20, hint: 'Older ones are removed automatically.' },
  { g: 'backups', k: 'backups.keepFull', label: 'Full backups to keep', type: 'int', min: 1, max: 200, def: 6, hint: 'Full backups are big, so keep only a few.' },
  { g: 'backups', k: 'update.backupFreshHours', label: 'Backup counts as recent for (hours)', type: 'int', min: 1, max: 720, def: 24, hint: 'Before an update the launcher checks you have a full backup this new, and tells you if not.' },
  { g: 'launcher', k: 'port', label: 'Launcher port', type: 'port', def: 7077, restart: true, hint: 'The port this page runs on. Needs a launcher restart.' },
  { g: 'launcher', k: 'pollSeconds', label: 'Check the server every (seconds)', type: 'int', min: 1, max: 120, def: 3, hint: 'How often the launcher looks at the server. Higher is lighter on a slow PC.' },
  { g: 'launcher', k: 'crashGraceSeconds', label: 'Crash detection delay (seconds)', type: 'int', min: 1, max: 300, def: 6, hint: 'How long the server must be gone before it counts as a crash.' },
  { g: 'launcher', k: 'title', label: 'Server window title', type: 'text', def: 'Game server', hint: 'The title of the window the server opens in.' }
];
const getPath = (o, k) => k.split('.').reduce((a, p) => (a && typeof a === 'object' ? a[p] : undefined), o);
function setPath(o, k, v) { const ps = k.split('.'); let a = o; for (let i = 0; i < ps.length - 1; i++) { if (!a[ps[i]] || typeof a[ps[i]] !== 'object') a[ps[i]] = {}; a = a[ps[i]]; } a[ps[ps.length - 1]] = v; }
function settingsGet() {
  const groups = { server: [], backups: [], launcher: [] };
  for (const d of SETTINGS_DEF) {
    if (d.hidden) continue;
    let v = getPath(cfg, d.k); if (v === undefined || v === null) v = d.def;
    groups[d.g].push({ k: d.k, label: d.label, type: d.type, hint: d.hint, value: v, def: d.def, restart: !!d.restart, opt: !!d.opt, min: d.min, max: d.max });
  }
  const sd = serverDir(); let folderOk = false; try { folderOk = fs.statSync(sd).isDirectory(); } catch (_) { /* missing */ }
  return { ok: true, product: PRODUCT, groups, serverName: serverNameNow(), serverDirResolved: sd, serverDirOk: folderOk, exeOk: fs.existsSync(path.join(sd, String(getPath(cfg, 'server.exe') || 'Open77.Server.exe'))), configPath: CFG_PATH, perf: perfInfo() };
}
function settingsCheckValue(d, raw) {
  if (d.type === 'port' || d.type === 'int') {
    const n = Number(String(raw).trim());
    const lo = d.type === 'port' ? 1 : d.min, hi = d.type === 'port' ? 65535 : d.max;
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: d.label + ' must be a whole number from ' + lo + ' to ' + hi + '.' };
    return { value: n };
  }
  const s = String(raw == null ? '' : raw).trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) return { error: d.label + ' has control characters in it.' };
  if (s.length > 300) return { error: d.label + ' is too long.' };
  if (!s) { if (d.opt) return { value: '' }; return { error: d.label + ' cannot be empty.' }; }
  if (d.type === 'text') { if (s.length > 80) return { error: d.label + ' is too long (80 characters at most).' }; return { value: s }; }
  if (d.type === 'dir' || d.type === 'dirrel') {
    if (/["<>|?*]/.test(s)) return { error: d.label + ' has characters in it that a folder name cannot have.' };
    return { value: s };
  }
  // file / folder inside the server folder: relative, no climbing out
  if (/^([a-zA-Z]:|[\\/])/.test(s) || s.split(/[\\/]/).includes('..')) return { error: d.label + ' must be a name inside the server folder (no full path, no "..").' };
  if (/[<>|?*"]/.test(s)) return { error: d.label + ' has characters in it that a file name cannot have.' };
  return { value: s.replace(/\\/g, '/') };
}
function settingsSet(body) {
  const ch = body && body.changes; if (!ch || typeof ch !== 'object') return { ok: false, error: 'Nothing to save.' };
  let raw; try { raw = readJson(CFG_PATH); } catch (e) { return { ok: false, error: 'dashboard.json cannot be read (' + e.message + ') - nothing written.' }; }
  const next = JSON.parse(JSON.stringify(raw)); const changed = [], notes = [], restart = [];
  for (const k of Object.keys(ch)) {
    const d = SETTINGS_DEF.find((x) => x.k === k); if (!d) return { ok: false, error: 'Unknown setting "' + k + '" - nothing written.' };
    const c = settingsCheckValue(d, ch[k]); if (c.error) return { ok: false, error: c.error + ' Nothing was saved.' };
    const was = getPath(raw, k);
    if (was === c.value || (was === undefined && c.value === d.def)) continue;
    setPath(next, k, c.value); changed.push(d.label + ': ' + (was === undefined ? String(d.def) : String(was)) + ' -> ' + String(c.value));
    if (d.restart) restart.push(d.label);
  }
  if (!changed.length) return { ok: true, changed: [], note: 'Nothing changed.' };
  const portsOf = (o) => [['Game port', getPath(o, 'server.ports.game') || 11778], ['Download port', getPath(o, 'server.ports.download') || 11779], ['Admin panel port', getPath(o, 'server.ports.warden') || 11780], ['Database port', getPath(o, 'server.dbPort') || 3306], ['Launcher port', next.port || 7077]];
  const ps = portsOf(next); const seen = {};
  for (const [n, p] of ps) { if (seen[p]) return { ok: false, error: seen[p] + ' and ' + n + ' are both ' + p + '. Each one needs its own port. Nothing was saved.' }; seen[p] = n; }
  if (next.serverDir !== raw.serverDir) {
    const nd = path.resolve(path.dirname(CFG_PATH), next.serverDir || '../server');
    let isDir = false; try { isDir = fs.statSync(nd).isDirectory(); } catch (_) { /* missing */ }
    if (!isDir) return { ok: false, error: 'The folder ' + nd + ' does not exist. Nothing was saved.' };
  }
  const stamp = stampNow(); const bdir = path.join(backupsDir(), 'config', stamp + '-settings');
  try { fs.mkdirSync(bdir, { recursive: true }); fs.copyFileSync(CFG_PATH, path.join(bdir, 'dashboard.json')); } catch (e) { return { ok: false, error: 'Could not back up dashboard.json first (' + e.message + ') - nothing written.' }; }
  const text = JSON.stringify(next, null, 1);
  let chk; try { chk = JSON.parse(text); } catch (_) { return { ok: false, error: 'The edit would break dashboard.json - nothing written.' }; }
  if (JSON.stringify(chk) !== JSON.stringify(next)) return { ok: false, error: 'The edit did not come out as intended - nothing written.' };
  atomicWrite(CFG_PATH, text); reloadConfig(); try { watchTick(true); } catch (_) { /* next tick */ }
  logChange('settings', 'Settings changed: ' + changed.join('; '), { ok: true, where: path.basename(bdir) });
  pushLog('Settings saved: ' + changed.length + ' change' + (changed.length === 1 ? '' : 's') + ' (backup ' + path.basename(bdir) + ')', 'dash');
  if (restart.length) notes.push('Restart the launcher for: ' + restart.join(', ') + '.');
  return { ok: true, changed, restart, backup: path.basename(bdir), note: 'Saved ' + changed.length + ' setting' + (changed.length === 1 ? '' : 's') + '.' + (notes.length ? ' ' + notes.join(' ') : '') };
}
// a fresh install has no dashboard.json yet: write one that works for any Open77 server, then Settings points it at the right folder
function defaultDash() {
  const d = JSON.parse(JSON.stringify(DEFAULT_DASH_BASE));
  const bk = d.buttons.find((b) => b.id === 'openbk'); if (bk) bk.open = '../' + path.basename(path.dirname(CFG_PATH)) + '/backups';
  return d;
}
function ensureConfigFile() {
  if (fs.existsSync(CFG_PATH)) return;
  try { fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true }); fs.writeFileSync(CFG_PATH, JSON.stringify(defaultDash(), null, 1)); console.log('  First run: created ' + CFG_PATH + '. Open Settings in the panel and point it at your server folder.'); }
  catch (e) { console.error('Could not create dashboard.json: ' + e.message); }
}
const DEFAULT_DASH_BASE = {
  title: 'Game server', port: 7077, serverDir: '../server', pollSeconds: 3, watchSeconds: 30, crashGraceSeconds: 6,
  server: { exe: 'Open77.Server.exe', startBat: '', config: 'server.jsonc', secrets: 'Secrets.cmd', log: 'logs/server-latest.log', resourcesRoot: 'resources', stopWaitSeconds: 12, ports: { game: 11778, download: 11779, warden: 11780 }, dbPort: 3306 },
  backups: { dir: 'backups', keep: 20, keepFull: 6, scriptsDir: 'scripts', full: { all: true } },
  automation: { restart: { enabled: false, maxPerHour: 3, delaySeconds: 10 }, daily: { enabled: false, time: '06:00' }, backup: { enabled: false, everyHours: 6, beforeRestart: true } },
  links: [],
  buttons: [
    { id: 'check', group: 'Server', label: 'Check server config', type: 'builtin', run: 'server.check', hint: 'Asks the server to validate its config without starting' },
    { id: 'dbtables', group: 'Database', label: 'Show database tables', type: 'builtin', run: 'db.tables', hint: 'Lists the tables in the database' },
    { id: 'openserver', group: 'Folders', label: 'Server folder', type: 'open', open: '.' },
    { id: 'openres', group: 'Folders', label: 'Resources folder', type: 'open', open: 'resources' },
    { id: 'openlogs', group: 'Folders', label: 'Server logs', type: 'open', open: 'logs' },
    { id: 'openupd', group: 'Folders', label: 'Updates (drop zips here)', type: 'open', open: 'updates' },
    { id: 'openbk', group: 'Folders', label: 'Backups', type: 'open', open: '../VNR_Launcher/backups' }
  ],
  progress: [],
  watch: { enabled: true, everyHours: 6, server: { enabled: true, url: 'https://open2077.net/host', regex: '(\\d+\\.\\d+\\.\\d+\\+op77\\.\\d+)' }, launcherRepo: '', scanDirs: [], repos: [] },
  update: { dirs: ['updates'], keepRollbacks: 5, requireDbBackup: true, packs: [{ id: 'server', label: 'Open77 server', kind: 'server', pattern: '^open77-server-(.+?)-win-x64(?: \\(\\d+\\))?\\.zip$', url: '' }] },
  resourceGroups: [
    { id: 'custom', label: 'Your scripts', hint: 'Written by you for this server. Backed up as "scripts".', prefix: ['scripts/'] },
    { id: 'system', label: 'System scripts (Open77 platform)', hint: 'Shipped with the Open77 server zip. Do not edit - a server update replaces them.', prefix: ['system/'] },
    { id: 'other', label: 'Libraries and add-ons', hint: 'Third-party or shared resources loaded next to the two groups above.', prefix: [] }
  ]
};

// ---------------------------------------------------------------- server details page: read and edit the public details in server.jsonc
const SERVER_FIELDS = [
  { k: 'identity.name', label: 'Server name', type: 'text', max: 96, hint: 'Shown in the server list. Colour codes work: $ff0 yellow, $o bold, $z reset.' },
  { k: 'identity.description', label: 'Description', type: 'area', max: 512, hint: 'A few lines about your server. Colour codes work here too.' },
  { k: 'identity.locale', label: 'Language', type: 'locale', hint: 'For example en-US, de-DE, ro-RO.' },
  { k: 'identity.tags', label: 'Tags', type: 'tags', hint: 'Up to 16, separated by commas: lowercase letters, numbers, - and _ (for example freeroam, english).' },
  { k: 'identity.website', label: 'Website', type: 'url', hint: 'Your website. Leave empty for none.' },
  { k: 'identity.discord', label: 'Discord', type: 'url', hint: 'Your Discord invite link. Leave empty for none.' },
  { k: 'identity.visibility', label: 'Visibility', type: 'enum', opts: ['public', 'unlisted', 'private'], hint: 'public = in the server list, unlisted = only with the address, private = hidden.' },
  { k: 'network.maximumPlayers', label: 'Player slots', type: 'int', min: 1, max: 4096, hint: 'The most players that can be connected at once.' },
  { k: 'network.port', label: 'Game port (UDP)', type: 'port', hint: 'The port players connect to. The panel keeps its own copy in step.' },
  { k: 'network.publicEndpoint', label: 'Public address', type: 'endpoint', hint: 'The address players use, with the port, for example play.example.net:11778. Leave empty if unsure.' },
  { k: 'masterServer.enabled', label: 'List on the public server list', type: 'bool', hint: 'Sends your server to the Open77 master list so players can find it.' },
  { k: 'voice.enabled', label: 'Voice chat', type: 'bool', hint: 'Built-in proximity voice chat.' }
];
function serverInfoGet() {
  const r = readServerCfg(); if (r.error) return { ok: false, error: r.error };
  const fields = SERVER_FIELDS.map((f) => { const v = getPath(r.obj, f.k); return { k: f.k, label: f.label, type: f.type, hint: f.hint, opts: f.opts, min: f.min, max: f.max, value: v === undefined ? null : v, present: v !== undefined }; });
  return { ok: true, fields, file: serverJsonc(), schema: r.obj.schemaVersion || null };
}
function serverInfoCheck(f, raw) {
  const t = f.type;
  if (t === 'bool') { if (raw === true || raw === 'true') return { value: true }; if (raw === false || raw === 'false') return { value: false }; return { error: f.label + ' must be on or off.' }; }
  if (t === 'int' || t === 'port') {
    const n = Number(String(raw).trim()); const lo = t === 'port' ? 1 : f.min, hi = t === 'port' ? 65535 : f.max;
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: f.label + ' must be a whole number from ' + lo + ' to ' + hi + '.' };
    return { value: n };
  }
  if (t === 'tags') {
    const list = (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const uniq = Array.from(new Set(list));
    if (uniq.length > 16) return { error: 'Tags: 16 at most.' };
    const bad = uniq.find((x) => !/^[a-z0-9][a-z0-9_-]{0,23}$/.test(x));
    if (bad) return { error: 'The tag "' + bad + '" is not allowed. Use lowercase letters, numbers, - and _ (24 characters at most, starting with a letter or number).' };
    return { value: uniq };
  }
  let s = String(raw == null ? '' : raw);
  if (t === 'area') { s = s.replace(/\r\n?/g, '\n').trim(); if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s)) return { error: f.label + ' has control characters in it.' }; if (s.length > f.max) return { error: f.label + ' is too long (' + f.max + ' characters at most).' }; return { value: s }; }
  s = s.replace(/\s+/g, ' ').trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) return { error: f.label + ' has control characters in it.' };
  if (t === 'text') { if (!s) return { error: f.label + ' cannot be empty.' }; if (s.length > f.max) return { error: f.label + ' is too long (' + f.max + ' characters at most).' }; return { value: s }; }
  if (t === 'locale') { if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s)) return { error: 'Language must look like en-US or ro-RO.' }; return { value: s }; }
  if (t === 'enum') { if (!f.opts.includes(s)) return { error: f.label + ' must be one of: ' + f.opts.join(', ') + '.' }; return { value: s }; }
  if (t === 'url') { if (!s) return { value: null }; if (!/^https?:\/\/[^\s"\\]+$/i.test(s) || s.length > 2048) return { error: f.label + ' must be a full web address starting with https://' }; return { value: s }; }
  if (t === 'endpoint') { if (!s) return { value: null }; const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(s); if (!m || +m[2] < 1 || +m[2] > 65535) return { error: 'Public address must look like play.example.net:11778 (a host name or IP, a colon, the port).' }; return { value: s }; }
  return { error: 'Unknown field type.' };
}
// edit one "section.key" value in server.jsonc text without touching anything else (comments, layout, other keys stay as they are)
function jsoncSetNested(text, pathStr, value) {
  const ps = pathStr.split('.'), sec = ps[0], key = ps[1];
  const s = jsonKeySpan(text, sec);
  if (!s || text[s.vs] !== '{') return { error: 'There is no "' + sec + '" section in server.jsonc.' };
  const inner = text.slice(s.vs, s.ve), kv = jsonKeySpan(inner, key), js = JSON.stringify(value);
  if (kv) return { text: text.slice(0, s.vs + kv.vs) + js + text.slice(s.vs + kv.ve) };
  const m = /^(\s*)(\S)/.exec(inner.slice(1));
  const indent = (m && m[1].indexOf('\n') >= 0) ? m[1] : ' ';
  const empty = !m || m[2] === '}';
  return { text: text.slice(0, s.vs + 1) + indent + JSON.stringify(key) + ': ' + js + (empty ? '' : ',') + text.slice(s.vs + 1) };
}
function serverInfoSet(body) {
  const ch = body && body.changes; if (!ch || typeof ch !== 'object') return { ok: false, error: 'Nothing to save.' };
  const r = readServerCfg(); if (r.error) return { ok: false, error: r.error + ' - nothing written' };
  const expected = JSON.parse(JSON.stringify(r.obj)); let text = r.text; const changed = []; let portNew = null;
  const same = (a, b) => JSON.stringify(a === undefined || a === null || a === '' ? null : a) === JSON.stringify(b === undefined || b === null || b === '' ? null : b);
  for (const k of Object.keys(ch)) {
    const f = SERVER_FIELDS.find((x) => x.k === k); if (!f) return { ok: false, error: 'Unknown field "' + k + '" - nothing written.' };
    const c = serverInfoCheck(f, ch[k]); if (c.error) return { ok: false, error: c.error + ' Nothing was saved.' };
    const was = getPath(r.obj, k); if (same(was, c.value)) continue;
    if (c.value === null && was === undefined) continue;
    const e = jsoncSetNested(text, k, c.value); if (e.error) return { ok: false, error: e.error + ' Nothing was saved.' };
    text = e.text; setPath(expected, k, c.value);
    changed.push(f.label + ': ' + (Array.isArray(was) ? was.join(', ') : String(was == null ? '' : was)).slice(0, 60) + ' -> ' + (Array.isArray(c.value) ? c.value.join(', ') : String(c.value == null ? '' : c.value)).slice(0, 60));
    if (k === 'network.port') portNew = c.value;
  }
  if (!changed.length) return { ok: true, changed: [], note: 'Nothing changed.' };
  let chk; try { chk = jsoncParse(text); } catch (_) { return { ok: false, error: 'The edit would break server.jsonc - nothing written.' }; }
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k2) => { o[k2] = canon(v[k2]); return o; }, {}) : v);
  if (JSON.stringify(canon(chk)) !== JSON.stringify(canon(expected))) return { ok: false, error: 'The edit did not come out as intended - nothing written.' };
  const backup = backupConfigFiles('before editing the server details');
  atomicWrite(serverJsonc(), text); watchTick(true); nameCache.mt = 0;
  let extra = '';
  if (portNew !== null) { const sr = settingsSet({ changes: { 'server.ports.game': portNew } }); if (!sr.ok) extra = ' The panel could not update its own copy of the game port (' + sr.error + ').'; }
  logChange('server.details', 'Server details changed: ' + changed.join('; '), { ok: true, where: path.basename(backup.where) });
  pushLog('server.jsonc: ' + changed.length + ' detail' + (changed.length === 1 ? '' : 's') + ' saved (backup ' + path.basename(backup.where) + ')', 'dash');
  return { ok: true, changed, backup: path.basename(backup.where), note: 'Saved ' + changed.length + ' change' + (changed.length === 1 ? '' : 's') + '. Restart the server so players see them.' + extra };
}

ensureConfigFile();
const LITE = true;
const LITE_PRO = ["/api/vps", "/api/monitor", "/api/crashes", "/api/mods", "/api/launcher", "/api/watch", "/api/auto", "/api/resources", "/api/patches", "/api/emergency", "/api/commands", "/api/update/download", "/api/update/source", "/api/update/auto", "/api/update/rollback", "/api/update/backupcheck", "/api/backup/verify", "/api/job/cancelall"];
let cfg = withVps(readJson(CFG_PATH));
const reloadConfig = () => { cfg = withVps(readJson(CFG_PATH)); };
const serverDir = () => path.resolve(path.dirname(CFG_PATH), cfg.serverDir || '../server');
const resourcesDir = () => path.join(serverDir(), cfg.server.resourcesRoot || 'resources');
const serverJsonc = () => path.join(serverDir(), cfg.server.config || 'server.jsonc');
const logFile = () => path.join(serverDir(), cfg.server.log || 'logs/server-latest.log');

// ChoomVille_Secrets.cmd:  set "NAME=value"  ->  environment for processes we start ourselves
function secretsEnv() {
  const env = {};
  try {
    const t = fs.readFileSync(path.join(serverDir(), cfg.server.secrets || 'ChoomVille_Secrets.cmd'), 'utf8');
    for (const m of t.matchAll(/^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"\s*$/gim)) env[m[1]] = m[2];
  } catch (_) { /* no secrets file: fine */ }
  return env;
}

// ------------------------------------------------------------------ small helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
function classify(line) {
  if (/\b(error|fail(ed|ure)?|fatal|exception|crash|traceback)\b/i.test(line)) return 'error';
  if (/\bwarn(ing)?\b/i.test(line)) return 'warn';
  return 'info';
}
function execP(file, args, opts) {
  return new Promise((resolve) => {
    const o = opts || {}, lg = o.log ? logExec(o.log, file, args, { cwd: o.cwd }) : null;
    const s0 = als.getStore();
    let off = () => {};
    const ch = execFile(file, args, Object.assign({ windowsHide: true, timeout: 10000, maxBuffer: 4 << 20 }, opts), (err, stdout, stderr) => {
      off();
      if (lg) lg(err ? (typeof err.code === 'number' ? err.code : 1) : 0, clip(String(stderr || stdout || (err && err.message) || '').trim().split('\n').slice(-3).join(' | '), 300), !!(s0 && s0.cancelled));
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (o.track) off = trackChild(ch);
  });
}
function tcpUp(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const stampNow = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
const human = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
function openTarget(target) {
  // a URL or a folder/file: hand it to the OS
  cmdNote('process', 'Open in the OS', String(target));
  if (IS_WIN) spawn('cmd.exe', ['/d', '/s', '/c', '"start "" "' + target + '""'], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// ------------------------------------------------------------------ event hub (SSE)
const clients = new Set();
function emit(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (_) { clients.delete(res); } }
}


// ------------------------------------------------------------------ WHO / WHAT context, jobs you can STOP, and the COMMAND LOG
// Every request and every background script runs inside an AsyncLocalStorage context that says WHO is acting
// (a person at the dashboard, a script/automation, or the launcher itself). The command log (logs/commands.jsonl)
// records every command with that actor; the job registry lets every running job be stopped for real
// (child processes are killed, downloads aborted, loops stop at the next checkpoint and clean up after themselves).
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const OSUSER = (() => { try { return os.userInfo().username || 'user'; } catch (_) { return 'user'; } })();
const SYSTEM_ACTOR = { type: 'system', name: 'launcher', via: 'launcher itself' };
const actorNow = () => { const s0 = als.getStore(); return (s0 && s0.actor) || SYSTEM_ACTOR; };
const actorLabel = (a) => (a.type === 'person' ? a.name : a.type === 'script' ? 'script: ' + a.name : 'system: ' + a.name);
// run fn as a named background script / automation, so everything it does is logged under that name


// ---- redaction: passwords, tokens and keys never reach the log
function redact(x) {
  return String(x == null ? '' : x)
    .replace(/(password|passwd|pwd|secret|token|api[_-]?key|authorization|MYSQL_PWD)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, '$1 ***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh***')
    .replace(/(Server=[^;]*;[^"\n]*?(?:Password|Pwd)=)[^;"\n]+/gi, '$1***');
}
const redactArgs = (a) => (a || []).map((x) => (/^-p.+/.test(String(x)) ? '-p***' : redact(x)));
const clip = (x, n) => { x = String(x == null ? '' : x); return x.length > n ? x.slice(0, n) + ' ...(+' + (x.length - n) + ' chars)' : x; };
function redactBody(b) {
  const o = {};
  for (const k of Object.keys(b || {})) o[k] = /pass|pw$|secret|token|key(?!s)|licen[cs]e/i.test(k) && !/keyfile|identityFile/i.test(k) ? '***' : (typeof b[k] === 'string' ? clip(redact(b[k]), 160) : b[k]);
  return o;
}

// ---- the command log
const CMD_KEEP = 4000, cmds = [], cmdById = new Map();
let cmdSeq = 0;
const cmdFile = () => path.join(dashDir(), 'logs', 'commands.jsonl');
function cmdPersist(line) {
  try {
    const f = cmdFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 12 << 20) fs.renameSync(f, f.replace(/\.jsonl$/, '.1.jsonl')); } catch (_) { /* no file yet */ }
    fs.appendFileSync(f, JSON.stringify(line) + '\n');
  } catch (_) { /* logging must never stop the launcher */ }
}
function cmdKeep(e) {
  cmds.push(e); cmdById.set(e.id, e);
  while (cmds.length > CMD_KEEP) { const o = cmds.shift(); cmdById.delete(o.id); }
}
// kind: 'request' (something asked through the dashboard / API), 'process' (a program the launcher started), 'job', 'automation', 'session'
function cmdBegin(kind, action, o) {
  o = o || {};
  const s0 = als.getStore();
  const e = { id: Date.now().toString(36) + '-' + (++cmdSeq), t: Date.now(), kind, action: clip(action, 120), detail: clip(redact(o.detail || ''), 700), actor: o.actor || actorNow(), status: 'running' };
  if (o.cmd) e.cmd = clip(redact(o.cmd), 2000);
  if (o.cwd) e.cwd = String(o.cwd);
  if (o.body && Object.keys(o.body).length) e.body = clip(JSON.stringify(redactBody(o.body)), 700);
  if (s0 && s0.cmdId && s0.cmdId !== e.id) e.parent = s0.cmdId;
  cmdKeep(e); cmdPersist(Object.assign({ ev: 'start' }, e)); emit('cmd', e);
  return e;
}
function cmdEnd(e, ok, o) {
  if (!e || e.status !== 'running') return;
  o = o || {};
  e.status = o.stopped ? 'stopped' : ok === false ? 'failed' : 'ok';
  e.ms = Date.now() - e.t;
  if (o.code !== undefined && o.code !== null) e.code = o.code;
  if (o.result) e.result = clip(redact(o.result), 900);
  cmdPersist({ ev: 'end', id: e.id, t: Date.now(), status: e.status, ms: e.ms, code: e.code, result: e.result });
  emit('cmd', e);
}
// something that happened instantly (no duration)
function cmdNote(kind, action, detail, o) { const e = cmdBegin(kind, action, Object.assign({ detail }, o || {})); cmdEnd(e, !(o && o.ok === false), { result: o && o.result }); return e; }
// a program the launcher starts: returns end(code, outputTail, stopped). Quiet contexts (polling) are not logged.
function logExec(label, file, args, o) {
  const s0 = als.getStore();
  if (s0 && s0.quiet) return () => {};
  const e = cmdBegin('process', label, { cmd: [file].concat(redactArgs(args || [])).join(' '), cwd: o && o.cwd });
  return (code, tail, stopped) => cmdEnd(e, stopped ? false : (code === 0 || code === undefined || code === null), { code, result: tail, stopped });
}
function loadCommands() {
  const map = new Map();
  for (const f of [cmdFile().replace(/\.jsonl$/, '.1.jsonl'), cmdFile()]) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const l of txt.split('\n').slice(-12000)) {
      if (!l) continue;
      let x; try { x = JSON.parse(l); } catch (_) { continue; }
      if (x.ev === 'end') { const e = map.get(x.id); if (e) Object.assign(e, { status: x.status, ms: x.ms, code: x.code, result: x.result }); }
      else if (x.id) { delete x.ev; map.set(x.id, x); }
    }
  }
  for (const e of map.values()) { if (e.status === 'running') { e.status = 'unknown'; e.result = 'The launcher was closed before this finished.'; } cmdKeep(e); }
}



// ---- jobs you can stop
const jobs = new Map();                 // key -> { key, killers:Set<fn>, store, cancelledBy, force }
class Cancelled extends Error { constructor(by) { super('Stopped by ' + (by || 'you')); this.cancelled = true; this.by = by; } }
function jobTop() { const s0 = als.getStore(); const k = s0 && s0.jobKeys && s0.jobKeys[s0.jobKeys.length - 1]; return k ? jobs.get(k) : null; }
function jobCheck() { const s0 = als.getStore(); if (s0 && s0.cancelled) throw new Cancelled(s0.cancelled); }
function killTree(p) {
  try { if (IS_WIN && p.pid) execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) { /* gone */ }
  try { p.kill(IS_WIN ? undefined : 'SIGKILL'); } catch (_) { /* gone */ }
}
function trackKiller(fn) { const j = jobTop(); if (!j) return () => {}; j.killers.add(fn); return () => j.killers.delete(fn); }
function trackChild(p) { const off = trackKiller(() => killTree(p)); p.once('close', off); p.once('exit', off); return off; }
function cancelJob(key, who) {
  const p = progs.get(key), j = jobs.get(key);
  if (!p || !j) return { ok: false, error: 'That job has already finished.' };
  if (p.stoppable === false) return { ok: false, error: p.stopNote || 'This step cannot be stopped safely - it finishes in a moment.' };
  if (j.cancelledBy) return { ok: true, note: 'Already stopping.' };
  const by = actorLabel(who || actorNow());
  j.cancelledBy = by; if (j.store) j.store.cancelled = by;
  p.stopping = true; p.stoppedBy = by; p.text = 'Stopping - waiting for the current step to end';
  emit('progress', { ev: 'set', p });
  pushLog('Stop requested for "' + p.label + '" by ' + by, 'dash');
  if (p.kind === 'start') once('server', () => serverStop('cancelled start (' + by + ')')).catch(() => {});
  if (p.kind === 'stop') j.force = true;
  for (const k of [...j.killers]) { try { k(); } catch (_) { /* gone */ } }
  return { ok: true, note: 'Stopping "' + p.label + '" ...' };
}

const jobList = () => [...progs.values()].map((p) => ({ key: p.key, label: p.label, kind: p.kind, actor: p.actor, since: p.t, stopping: !!p.stopping, stoppable: p.stoppable !== false, stage: p.stage, step: p.step, steps: p.steps, done: p.done, total: p.total }));

// ------------------------------------------------------------------ progress (SSE "progress"): REAL counts only
// A bar is determinate only when the code knows done and total (files copied, bytes received, items checked).
// Otherwise total stays 0 and the page shows a moving bar plus the step text. Nothing is estimated from time.
const progs = new Map(), progLast = new Map();
function progStart(key, label, o) {
  const a = actorNow(), s0 = als.getStore();
  const p = Object.assign({ key, label, done: 0, total: 0, unit: '', text: '', stage: '', step: 0, steps: 0, kind: '', t: Date.now(), stoppable: true, stopNote: '', stopping: false, actor: actorLabel(a), actorType: a.type }, o || {});
  progs.set(key, p);
  jobs.set(key, { key, killers: new Set(), store: s0 || null, cancelledBy: '', force: false });
  if (s0) { s0.jobKeys = s0.jobKeys || []; s0.jobKeys.push(key); }
  emit('progress', { ev: 'start', p }); return key;
}
function progSet(key, patch) {
  const p = progs.get(key); if (!p) return;
  const newStage = patch.stage !== undefined && patch.stage !== p.stage;
  Object.assign(p, patch);
  const now = Date.now();
  if (!newStage && now - (progLast.get(key) || 0) < 150 && !(p.total && p.done >= p.total)) return;
  progLast.set(key, now); emit('progress', { ev: 'set', p });
}
function progStage(key, stage, step, steps) { progSet(key, { stage, step: step || 0, steps: steps || 0, done: 0, total: 0, unit: '', text: '' }); }
function progEnd(key, ok, text, extra) {
  const p = progs.get(key); if (!p) return;
  const j = jobs.get(key); jobs.delete(key);
  if (j && j.store && j.store.jobKeys) { const i = j.store.jobKeys.indexOf(key); if (i >= 0) j.store.jobKeys.splice(i, 1); }
  const stopped = !!(j && j.cancelledBy);
  progs.delete(key); progLast.delete(key);
  emit('progress', { ev: 'end', p: Object.assign({}, p, { ok: stopped ? false : !!ok, stopped, stopping: false, text: stopped ? 'Stopped by ' + j.cancelledBy + (text && !/^Stopped/.test(text) ? ' - ' + text : '') : (text || p.text || ''), secs: Math.round((Date.now() - p.t) / 100) / 10 }, extra || {}) });
}

// ------------------------------------------------------------------ change log (append-only, logs/changes.jsonl)
const dashDir = () => path.dirname(CFG_PATH);
const changeFile = () => path.join(dashDir(), 'logs', 'changes.jsonl');
const changes = [];
function logChange(kind, detail, extra) {
  const e = Object.assign({ t: Date.now(), kind, detail: String(detail) }, extra || {});
  changes.push(e); if (changes.length > 800) changes.shift();
  try { fs.mkdirSync(path.dirname(changeFile()), { recursive: true }); fs.appendFileSync(changeFile(), JSON.stringify(e) + '\n'); } catch (_) { /* keep running */ }
  emit('change', e);
  return e;
}
function loadChanges() {
  try {
    const t = fs.readFileSync(changeFile(), 'utf8').trim().split('\n').slice(-800);
    for (const l of t) { try { changes.push(JSON.parse(l)); } catch (_) { /* skip bad line */ } }
  } catch (_) { /* first run */ }
}

// ------------------------------------------------------------------ server log tail
const LOG_KEEP = 3000;
const logLines = [];
let logPos = 0, logEnc = null, logId = 0, logKey = '';
function pushLog(text, src) {
  const t = stripAnsi(text).replace(/\r/g, '');
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const e = { id: ++logId, t: Date.now(), l: classify(line), s: src || 'server', m: line };
    logLines.push(e);
    if (logLines.length > LOG_KEEP) logLines.shift();
    emit('line', e);
  }
}
// Windows PowerShell's Tee-Object writes UTF-16LE with a BOM, cmd redirection writes UTF-8: handle both.
function decode(buf, enc) { return enc === 'utf16le' ? buf.toString('utf16le') : buf.toString('utf8'); }
async function tailTick() {
  const f = logFile();
  let st;
  try { st = fs.statSync(f); } catch (_) { return; }
  const key = String(st.birthtimeMs || 0);
  if (st.size < logPos || (logKey && key !== logKey && st.birthtimeMs)) {
    logPos = 0; logEnc = null;
    pushLog('---- new server log started ----', 'dash');
  }
  logKey = key;
  if (st.size === logPos) return;
  const fd = fs.openSync(f, 'r');
  try {
    let start = logPos;
    if (logPos === 0) {
      const head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0);
      logEnc = head[0] === 0xff && head[1] === 0xfe ? 'utf16le' : 'utf8';
      start = logEnc === 'utf16le' ? 2 : 0;
      // first read of a big existing file: only the last 256 KB
      if (st.size - start > 262144) { start = st.size - 262144; if (logEnc === 'utf16le' && start % 2) start++; }
    }
    let end = st.size;
    if (logEnc === 'utf16le' && (end - start) % 2) end--;     // never split a UTF-16 unit
    if (end <= start) return;
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    // keep a half-written last line for the next tick
    let text = decode(buf, logEnc).replace(/^﻿/, '');
    const cut = text.lastIndexOf('\n');
    if (cut === -1 && st.size - logPos < 8192) return;
    if (cut !== -1 && cut < text.length - 1) {
      const keep = text.slice(cut + 1);
      const keepBytes = Buffer.byteLength(keep, logEnc === 'utf16le' ? 'utf16le' : 'utf8');
      text = text.slice(0, cut + 1);
      logPos = end - keepBytes;
    } else logPos = end;
    pushLog(text, 'server');
  } finally { fs.closeSync(fd); }
}

// ------------------------------------------------------------------ server process control
let lastProc = { running: false, pids: [], startedAt: null };
let transition = null;   // 'starting' | 'stopping' | null
let transitionUntil = 0;

let fsCache = { key: '', val: null };
async function findServer() {
  const exe = cfg.server.exe;
  if (IS_WIN) {
    const tl = await execP('tasklist.exe', ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq ' + exe], { timeout: 10000 });
    if (!tl.err) {
      const ids = tl.stdout.split(/\r?\n/).map((l) => (l.match(/^"[^"]*","(\d+)"/) || [])[1]).filter(Boolean).sort();
      if (!ids.length) { fsCache = { key: '', val: null }; return { running: false, pids: [], startedAt: null }; }
      const key = ids.join(',');
      if (fsCache.val && fsCache.key === key) return { running: fsCache.val.running, pids: fsCache.val.pids.slice(), startedAt: fsCache.val.startedAt };
      const v = await findServerFull(exe);
      fsCache = { key, val: v }; return v;
    }
    return findServerFull(exe);
  }
  return findServerFull(exe);
}
async function findServerFull(exe) {
  if (IS_WIN) {
    const d = serverDir().replace(/'/g, "''");
    const ps = "$d='" + d + "'; Get-CimInstance Win32_Process -Filter \"Name='" + exe + "'\" | " +
      "Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d,[StringComparison]::OrdinalIgnoreCase) } | " +
      "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }";
    const r = await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    const rows = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));
    return { running: rows.length > 0, pids: rows.map((x) => +x[0]), startedAt: rows.length ? rows[0][1] : null };
  }
  const match = cfg.server.match || exe;
  const r = await execP('pgrep', ['-f', match]);
  const pids = r.stdout.split('\n').map((s) => +s.trim()).filter((n) => n && n !== process.pid);
  if (!pids.length) return { running: false, pids: [], startedAt: null };
  const e = await execP('ps', ['-o', 'etimes=', '-p', String(pids[0])]);
  const secs = parseInt(e.stdout.trim(), 10);
  return { running: true, pids, startedAt: isNaN(secs) ? null : new Date(Date.now() - secs * 1000).toISOString() };
}

function startInWindow(target, cwd) {
  // run a .bat in its own console window (so pauses, prompts and Ctrl+C behave like double-clicking it)
  if (IS_WIN) {
    const cmd = '"start "' + (cfg.title || 'Game server') + '" /D "' + cwd + '" "' + target + '""';
    cmdNote('process', 'Open server window', 'cmd.exe /c start ' + target, { cwd, cmd: 'cmd.exe /d /s /c ' + cmd });
    spawn('cmd.exe', ['/d', '/s', '/c', cmd], { cwd, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    return Promise.resolve();
  }
  // non-Windows (tests): run the command detached, output to the log file like the logged .bat does
  const lf = logFile();
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  const out = fs.openSync(lf, 'w');
  const parts = Array.isArray(target) ? target : String(target).split(' ');
  cmdNote('process', 'Start server process', parts.join(' '), { cwd, cmd: parts.join(' ') });
  const p = spawn(parts[0], parts.slice(1), { cwd, detached: true, stdio: ['ignore', out, out], env: Object.assign({}, process.env, secretsEnv()) });
  p.unref();
  return Promise.resolve();
}

let wantRunning = false;      // true once the server was seen running / started; false after a stop from here
let intentionalStop = false;  // a stop from here is in progress: the poll must not re-arm the watchdog
async function serverStart(src) {
  src = typeof src === 'string' ? src : 'you';
  const cur = await findServer();
  if (cur.running) return { ok: false, error: 'The server is already running (PID ' + cur.pids.join(', ') + ').' };
  const startTarget = cfg.server.startBat || cfg.server.exe || 'Open77.Server.exe';
  const bat = path.join(serverDir(), startTarget);
  if (IS_WIN && !fs.existsSync(bat)) { logChange('server.start', 'FAILED (' + src + '): ' + startTarget + ' not found', { ok: false }); return { ok: false, error: startTarget + ' not found in ' + serverDir() + '. Open Settings and check the server folder.' }; }
  archiveServerLog('prestart');
  lastLauncherStart = Date.now();
  transition = 'starting'; transitionUntil = Date.now() + 90000;
  progStart('srv', 'Starting the server', { kind: 'start', stage: 'Waiting for the server process to appear' });
  wantRunning = true; intentionalStop = false;
  pushLog('Starting the server ...', 'dash');
  logChange('server.start', 'Server start requested by ' + src + ' (' + actorLabel(actorNow()) + ')', { ok: true });
  await startInWindow(IS_WIN ? startTarget : (cfg.server.testStart || startTarget), serverDir());
  return { ok: true };
}

async function gracefulCtrlC(pid) {
  if (!IS_WIN) { cmdNote('process', 'Send Ctrl+C to server PID ' + pid, 'kill -INT ' + pid, { cmd: 'kill -INT ' + pid }); try { process.kill(pid, 'SIGINT'); return true; } catch (_) { return false; } }
  const ps =
    "$sig='[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole(); [DllImport(\"kernel32.dll\")] public static extern bool AttachConsole(uint p); " +
    "[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool a); [DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'; " +
    "Add-Type -MemberDefinition $sig -Name W -Namespace CV; [void][CV.W]::FreeConsole(); " +
    "if ([CV.W]::AttachConsole(" + (pid | 0) + ")) { [void][CV.W]::SetConsoleCtrlHandler([IntPtr]::Zero,$true); [void][CV.W]::GenerateConsoleCtrlEvent(0,0); Start-Sleep -Milliseconds 600; [void][CV.W]::FreeConsole(); 'sent' } else { 'noconsole' }";
  const r = await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, log: 'Send Ctrl+C to server PID ' + (pid | 0) });
  return /sent/.test(r.stdout);
}
async function hardKill(pid) {
  if (IS_WIN) await execP('taskkill', ['/PID', String(pid), '/T', '/F'], { log: 'Force-kill server PID ' + pid });
  else { cmdNote('process', 'Force-kill server PID ' + pid, 'kill -KILL ' + pid, { cmd: 'kill -KILL ' + pid }); try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
}

async function serverStop(src) {
  src = typeof src === 'string' ? src : 'you';
  wantRunning = false;                       // a stop from here is intended: no auto-restart
  intentionalStop = true;
  const cur = await findServer();
  if (!cur.running) { intentionalStop = false; return { ok: true, note: 'The server was not running.' }; }
  transition = 'stopping'; transitionUntil = Date.now() + 40000;
  const wait = cfg.server.stopWaitSeconds || 12;
  const sk = src === 'update' ? null : progStart('srv', 'Stopping the server', { kind: 'stop', stage: 'Asked it to shut down cleanly - waiting up to ' + wait + ' s' });
  pushLog('Stopping the server (clean shutdown, waiting up to ' + wait + ' s) ...', 'dash');
  for (const pid of cur.pids) await gracefulCtrlC(pid);
  for (let i = 0; i < wait * 2; i++) {
    await sleep(500);
    if (sk && jobs.get(sk) && jobs.get(sk).force) { pushLog('Forcing the stop now (asked from the dashboard).', 'dash'); break; }
    if (sk) progSet(sk, { text: ((i + 1) / 2) + ' s waited (limit ' + wait + ' s)' });
    if (!(await findServer()).running) { pushLog('Server stopped cleanly.', 'dash'); transition = null; if (sk) progEnd(sk, true, 'Server stopped cleanly'); logChange('server.stop', 'Server stopped cleanly (' + src + ')', { ok: true }); return { ok: true, clean: true }; }
  }
  pushLog('Server did not stop in time - forcing it.', 'dash');
  if (sk) progSet(sk, { stage: 'Did not stop in time - forcing it', text: '' });
  for (const pid of (await findServer()).pids) await hardKill(pid);
  await sleep(800);
  const left = await findServer();
  transition = null;
  if (left.running) { if (sk) progEnd(sk, false, 'Could not stop the server (PID ' + left.pids.join(', ') + ')'); logChange('server.stop', 'Could not stop the server (PID ' + left.pids.join(', ') + ')', { ok: false }); return { ok: false, error: 'Could not stop the server (PID ' + left.pids.join(', ') + ').' }; }
  pushLog('Server stopped (forced).', 'dash'); if (sk) progEnd(sk, true, 'Server stopped (it had to be forced)');
  logChange('server.stop', 'Server stopped by force after ' + wait + ' s (' + src + ')', { ok: true });
  return { ok: true, clean: false };
}

// EMERGENCY STOP: no clean shutdown, no waiting, no questions. Kills the game server's whole process tree at once
// (using the PIDs already known, so nothing has to be looked up first), stops every running job, then double-checks.



async function serverRestart(src) {
  src = typeof src === 'string' ? src : 'you';
  const s = await serverStop(src);
  if (!s.ok) return s;
  await sleep(1500);
  return serverStart(src);
}

// run a command, stream its output into the "actions" console
let actionSeq = 0;
function runCapture(label, file, args, cwd, env) {
  const id = actBegin(label);                    // progress bar in the dock (with a Stop button) + the "action" console
  const lg = logExec(label, file, args, { cwd });
  const st = als.getStore();
  return new Promise((resolve) => {
    let p;
    try { p = spawn(file, args, { cwd, windowsHide: true, env: Object.assign({}, process.env, secretsEnv(), env || {}) }); }
    catch (e) { actLn(id, 'ERROR: ' + e.message); actEnd(id, -1, label); lg(-1, String(e.message)); return resolve({ ok: false, error: String(e.message) }); }
    const off = trackChild(p);
    let out = '', timedOut = false;
    const feed = (b) => { const t = stripAnsi(b.toString('utf8')); out += t; for (const l of t.split(/\r?\n/)) if (l.trim()) actLn(id, l); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', (e) => { actLn(id, 'ERROR: ' + e.message); });
    const timer = setTimeout(() => { timedOut = true; killTree(p); }, 120000);
    p.on('close', (code) => {
      clearTimeout(timer); off();
      const stopped = !!(st && st.cancelled);
      actEnd(id, stopped ? 1 : code, label);
      lg(code, clip(out.trim().split('\n').slice(-3).join(' | '), 300), stopped);
      if (stopped) return resolve({ ok: false, cancelled: true, error: 'Stopped by ' + st.cancelled, output: out.slice(-4000) });
      resolve({ ok: code === 0, code, output: out.slice(-4000), error: timedOut ? 'Timed out after 120 s' : undefined });
    });
  });
}

async function checkConfig() {
  const exe = path.join(serverDir(), cfg.server.exe);
  if (IS_WIN && !fs.existsSync(exe)) return { ok: false, error: cfg.server.exe + ' not found' };
  const r = await runCapture('Check server.jsonc', cfg.server.checkCmd ? cfg.server.checkCmd[0] : exe,
    cfg.server.checkCmd ? cfg.server.checkCmd.slice(1) : ['--no-setup', '--config', cfg.server.config || 'server.jsonc', '--check-config'], serverDir());
  return r;
}

// Which tables exist in the game database, grouped by prefix (opx77_ = framework, cv_ = phone, open77_ = platform)
async function dbTables() {
  const c = parseConn(secretsEnv().OP77_DATABASE_CONNECTION || process.env.OP77_DATABASE_CONNECTION);
  if (!c.db || !c.user) return { ok: false, error: 'No OP77_DATABASE_CONNECTION in ChoomVille_Secrets.cmd.' };
  const dump = findDumpExe();
  if (!dump) return { ok: false, error: 'MariaDB tools not found. Set server.mariadbBin in dashboard.json.' };
  const dir = path.dirname(dump); let cli = null;
  for (const n of IS_WIN ? ['mariadb.exe', 'mysql.exe'] : ['mariadb', 'mysql']) { const f = path.join(dir, n); if (dir !== '.' && fs.existsSync(f)) { cli = f; break; } }
  if (!cli) cli = IS_WIN ? null : 'mysql';
  if (!cli) return { ok: false, error: 'mariadb.exe not found next to ' + dump };
  const q = "SELECT CONCAT(RPAD(SUBSTRING_INDEX(table_name,'_',1),10,' '),COUNT(*),' tables') FROM information_schema.tables WHERE table_schema='" + c.db.replace(/[^\w]/g, '') + "' GROUP BY SUBSTRING_INDEX(table_name,'_',1) ORDER BY 1;";
  const r = await runCapture('Database tables in ' + c.db, cli, ['-h', c.host, '-P', String(c.port), '-u', c.user, '-N', '-e', q], serverDir(), { MYSQL_PWD: c.pwd });
  return r;
}

// The game catalogue (cv_cat_*: clothing, cyberware, factions, items, manufacturers, meta, npcs, props, vehicles, weapons).
// Status counts the rows; load runs ../database/cv_catalog.sql (it drops and refills only the cv_cat_* tables).
const CATALOG_TABLES = ['cv_cat_clothing', 'cv_cat_cyberware', 'cv_cat_factions', 'cv_cat_items', 'cv_cat_manufacturers', 'cv_cat_meta', 'cv_cat_npcs', 'cv_cat_props', 'cv_cat_vehicles', 'cv_cat_weapons'];
function dbCli() {
  const c = parseConn(secretsEnv().OP77_DATABASE_CONNECTION || process.env.OP77_DATABASE_CONNECTION);
  if (!c.db || !c.user) return { error: 'No OP77_DATABASE_CONNECTION in ChoomVille_Secrets.cmd.' };
  const dump = findDumpExe();
  if (!dump) return { error: 'MariaDB tools not found. Set server.mariadbBin in dashboard.json.' };
  const dir = path.dirname(dump); let cli = null;
  for (const n of IS_WIN ? ['mariadb.exe', 'mysql.exe'] : ['mariadb', 'mysql']) { const f = path.join(dir, n); if (dir !== '.' && fs.existsSync(f)) { cli = f; break; } }
  if (!cli) cli = IS_WIN ? null : 'mysql';
  if (!cli) return { error: 'mariadb.exe not found next to ' + dump };
  return { c, cli };
}
async function dbCatalog(load) {
  const k = dbCli(); if (k.error) return { ok: false, error: k.error };
  const db = k.c.db.replace(/[^\w]/g, '');
  const base = ['-h', k.c.host, '-P', String(k.c.port), '-u', k.c.user, '-D', db];
  const env = { MYSQL_PWD: k.c.pwd };
  if (load) {
    const file = path.resolve(serverDir(), '..', 'database', 'cv_catalog.sql');
    if (!fs.existsSync(file)) return { ok: false, error: 'Not found: ' + file };
    const r = await runCapture('Load game catalogue (cv_cat_*) into ' + db, k.cli, base.concat(['--default-character-set=utf8mb4', '-e', 'source ' + file.replace(/\\/g, '/')]), serverDir(), env);
    if (!r.ok) return r;
    // the item catalogue (every opx item, generated by database/build_items_sql.py) goes in after the dump, which refills cv_cat_items with its 20 old rows
    const items = path.resolve(serverDir(), '..', 'database', 'cv_items.sql');
    if (fs.existsSync(items)) {
      const r2 = await runCapture('Load item catalogue (cv_cat_items) into ' + db, k.cli, base.concat(['--default-character-set=utf8mb4', '-e', 'source ' + items.replace(/\\/g, '/')]), serverDir(), env);
      if (!r2.ok) return r2;
    }
  }
  // one silent count per table; a missing table is reported as MISSING instead of printing a database error
  const lines = [];
  for (const t of CATALOG_TABLES) {
    const n = await new Promise((resolve) => {
      execFile(k.cli, base.concat(['-N', '-e', 'SELECT COUNT(*) FROM `' + t + '`']), { cwd: serverDir(), windowsHide: true, timeout: 30000, env: Object.assign({}, process.env, env) },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
    lines.push(t + ': ' + (n === null ? 'MISSING' : n + ' rows'));
  }
  const text = lines.join('\n');
  emit('action', { id: ++actionSeq, state: 'start', label: 'Game catalogue in ' + db, by: actorNow().type === 'person' ? actorNow().name : '', type: actorNow().type });
  for (const l of lines) emit('action', { id: actionSeq, state: 'line', line: l });
  emit('action', { id: actionSeq, state: 'end', code: 0, label: 'Game catalogue in ' + db });
  return { ok: true, output: text };
}

// ------------------------------------------------------------------ buttons (dashboard.json)
function buttonById(id) { return (cfg.buttons || []).find((b) => b.id === id); }
async function runButton(b) {
  const dir = serverDir();
  const base = b.cwd ? path.resolve(dir, b.cwd) : dir;
  if (b.requireStopped && (await findServer()).running) return { ok: false, error: 'Stop the server first - ' + b.label + ' only works while it is stopped.' };
  if (b.type === 'builtin') {
    if (b.run === 'server.start') return serverStart();
    if (b.run === 'server.stop') return serverStop();
    if (b.run === 'server.restart') return serverRestart();
    if (b.run === 'server.check') return checkConfig();
    if (b.run === 'db.tables') return dbTables();
    if (b.run === 'db.catalog.status') return dbCatalog(false);
    if (b.run === 'db.catalog.load') return dbCatalog(true);
    if (/^vps\./.test(b.run || '')) { const f = vpsMod && vpsMod.builtin(b.run); return f ? f : { ok: false, error: vpsMod ? 'unknown VPS action ' + b.run : 'VPS support did not load (vps.js missing or broken).' }; }
    return { ok: false, error: 'unknown builtin ' + b.run };
  }
  if (b.type === 'open') {
    const t = /^https?:\/\//i.test(b.open) ? b.open : path.resolve(base, b.open);
    if (!/^https?:\/\//i.test(t) && !fs.existsSync(t)) { try { fs.mkdirSync(t, { recursive: true }); } catch (_) { return { ok: false, error: 'not found: ' + t }; } }
    openTarget(t); return { ok: true };
  }
  if (b.type === 'window') {
    const f = path.resolve(base, b.run);
    if (!fs.existsSync(f)) return { ok: false, error: b.run + ' not found in ' + base };
    await startInWindow(IS_WIN ? path.basename(f) : [f], path.dirname(f));
    return { ok: true, note: 'Opened in its own window.' };
  }
  if (b.type === 'run') {
    const cmd = b.cmd || [];
    return runCapture(b.label, cmd[0], cmd.slice(1), base);
  }
  return { ok: false, error: 'unknown button type ' + b.type };
}

// ------------------------------------------------------------------ resources: the "load" list of server.jsonc
function scanResources() {
  const root = resourcesDir();
  const found = [];
  (function walk(dir, depth) {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    if (ents.some((e) => e.isFile() && e.name === 'open77.lua')) { found.push(path.relative(root, dir).split(path.sep).join('/')); return; }
    for (const e of ents) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  })(root, 0);
  return found.sort();
}
function readManifest(rel) {
  const f = path.join(resourcesDir(), rel, 'open77.lua');
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  const name = (t.match(/^\s*resource\s+"([^"]+)"/m) || [])[1] || path.basename(rel);
  const version = (t.match(/^\s*version\s+"([^"]+)"/m) || [])[1] || '';
  const deps = [...t.matchAll(/^\s*dependency\s+"([^"]+)"/gm)].map((m) => m[1].trim().split(/\s+/)[0]);
  return { name, version, deps };
}
const LOAD_RE = /("load"\s*:\s*\[)([\s\S]*?)(\n?[ \t]*\])/;
function parseLoad(text) {
  const m = text.match(LOAD_RE);
  if (!m) return null;
  const lines = m[2].split('\n');
  const items = lines.map((ln) => {
    const e = ln.match(/^(\s*)"([^"]+)"\s*,?\s*(\/\/.*)?$/);
    return e ? { kind: 'entry', indent: e[1], path: e[2], comment: e[3] || '' } : { kind: 'other', raw: ln };
  });
  return { m, items };
}

// Where a script lives decides its group: choomville/... is ours, system/... ships with the Open77 platform, the rest are add-ons.
// Change the folders in dashboard.json -> "resourceGroups" if you move things; the last entry catches everything else.
const RES_GROUPS_DEFAULT = [
  { id: 'custom', label: 'Custom scripts (ChoomVille)', hint: 'Written for this server. Backed up as "scripts".', prefix: ['choomville/'] },
  { id: 'system', label: 'System scripts (Open77 platform)', hint: 'Shipped with the Open77 server zip. Do not edit - the server update replaces them.', prefix: ['system/'] },
  { id: 'other', label: 'Libraries and add-ons', hint: 'Third-party or shared resources loaded next to the two groups above.', prefix: [] },
];
function resGroups() { const g = cfg.resourceGroups; return Array.isArray(g) && g.length ? g : RES_GROUPS_DEFAULT; }
function resGroupOf(rel, groups) {
  const p = String(rel).toLowerCase();
  for (const g of groups) if ((g.prefix || []).some((x) => p.startsWith(String(x).toLowerCase()))) return g.id;
  return groups[groups.length - 1].id;
}
function loadListRaw() {
  let text; try { text = fs.readFileSync(serverJsonc(), 'utf8'); } catch (e) { return { error: 'cannot read ' + serverJsonc() }; }
  const p = parseLoad(text);
  if (!p) return { error: 'no "load" list found in server.jsonc' };
  const entries = p.items.filter((i) => i.kind === 'entry').map((i) => i.path);
  const man = {};
  for (const e of entries) man[e] = readManifest(e);
  const names = new Set(Object.values(man).filter(Boolean).map((x) => x.name));
  const rows = entries.map((e) => {
    const mf = man[e];
    const missing = mf ? mf.deps.filter((d) => !names.has(d)) : [];
    return { path: e, exists: !!mf, name: mf ? mf.name : null, version: mf ? mf.version : '', needs: missing, deps: mf ? mf.deps : [] };
  });
  const all = scanResources();
  const groups = resGroups();
  for (const r of rows) r.group = resGroupOf(r.path, groups);
  const available = all.filter((a) => !entries.includes(a)).map((a) => ({ path: a, group: resGroupOf(a, groups) }));
  return { rows, available, groups: groups.map((g) => ({ id: g.id, label: g.label, hint: g.hint || '' })) };
}
// ------------------------------------------------------------------ backups
// backups/config/<stamp>/   server.jsonc, acl.jsonc, secrets, launcher .bat files
// backups/scripts/<stamp>/  resources/choomville (our own scripts)
// backups/db/<stamp>_<db>.sql.gz   a database dump (uses the game's own database login)
const backupsDir = () => path.resolve(dashDir(), (cfg.backups && cfg.backups.dir) || 'backups');
function pruneBackups(type) {
  const keep = (cfg.backups && cfg.backups.keep) || 20;
  const dir = path.join(backupsDir(), type);
  let names; try { names = fs.readdirSync(dir).sort(); } catch (_) { return; }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (_) { /* in use */ }
  }
}
function backupConfigFiles(reason) {
  const dest = path.join(backupsDir(), 'config', stampNow());
  fs.mkdirSync(dest, { recursive: true });
  const names = (cfg.backups && cfg.backups.configFiles) || ['server.jsonc', 'acl.jsonc', 'ChoomVille_Secrets.cmd', 'ChoomVille_Start.bat', 'ChoomVille_Start_Logged.bat'];
  const copied = [];
  for (const n of names) {
    const src = path.join(serverDir(), n);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, n)); copied.push(n); }
  }
  pruneBackups('config');
  logChange('backup.config', 'Config backup (' + (reason || 'manual') + '): ' + copied.join(', '), { ok: true, where: path.basename(dest) });
  return { ok: true, where: dest, files: copied };
}

function parseConn(s) {
  const o = {}; for (const part of String(s || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1); }
  return { host: o.server || '127.0.0.1', port: o.port || '3306', db: o.database, user: o['user id'] || o.uid || o.user, pwd: o.password || o.pwd || '' };
}
function findDumpExe() {
  if (cfg.server.mariadbBin) for (const n of ['mariadb-dump.exe', 'mysqldump.exe']) { const f = path.join(cfg.server.mariadbBin, n); if (fs.existsSync(f)) return f; }
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    let dirs = []; try { dirs = fs.readdirSync(pf).filter((d) => /^MariaDB/i.test(d)).sort().reverse(); } catch (_) { /* none */ }
    for (const d of dirs) for (const n of ['mariadb-dump.exe', 'mysqldump.exe']) { const f = path.join(pf, d, 'bin', n); if (fs.existsSync(f)) return f; }
    return null;
  }
  return 'mysqldump';
}

// Plain .sql dump of the game database to a given file (used by the VPS pack). The connection string is read here and never leaves this process or the log.


function dirSize(p, cap) {
  let n = 0;
  (function w(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of es) { if (n > cap) return; const f = path.join(d, e.name); if (e.isDirectory()) w(f); else { try { n += fs.statSync(f).size; } catch (_) { /* skip */ } } } })(p);
  return n;
}
function listBackups() {
  const out = [];
  for (const type of ['config', 'scripts', 'db', 'full']) {
    const dir = path.join(backupsDir(), type);
    let names = []; try { names = fs.readdirSync(dir).filter((n) => !n.endsWith('.partial')).sort().reverse().slice(0, 8); } catch (_) { /* none */ }
    for (const n of names) {
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch (_) { continue; }
      out.push({ type, name: n, t: st.mtimeMs, size: st.isDirectory() ? dirSizeCached(f, 5e9, st.mtimeMs) : st.size });
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, 14);
}


// ------------------------------------------------------------------ progress checklist
function loadState() { return readJson(STATE_PATH, { progress: {} }); }
function setProgress(id, status) {
  if (!['todo', 'doing', 'testing', 'done'].includes(status)) return { ok: false, error: 'bad status' };
  const item = (cfg.progress || []).find((p) => p.id === id);
  if (!item) return { ok: false, error: 'unknown item' };
  const s = loadState(); s.progress = s.progress || {}; s.progressAt = s.progressAt || {}; const prev = s.progress[id] || item.status || 'todo'; s.progress[id] = status; s.progressAt[id] = new Date().toISOString().slice(0, 10);
  atomicWrite(STATE_PATH, JSON.stringify(s, null, 2));
  logChange('progress', item.title + ': ' + prev + ' -> ' + status, { ok: true });
  return { ok: true };
}

// ------------------------------------------------------------------ automation: crash restart, daily restart, scheduled backups
const AUTO_SCHEMA = {
  restart: { enabled: 'bool', maxPerHour: [1, 20], delaySeconds: [0, 300] },
  daily: { enabled: 'bool', time: 'time' },
  backup: { enabled: 'bool', everyHours: [1, 168], beforeRestart: 'bool' },
};
function autoSettings() {
  const def = { restart: { enabled: false, maxPerHour: 3, delaySeconds: 10 }, daily: { enabled: false, time: '06:00' }, backup: { enabled: false, everyHours: 6, beforeRestart: true } };
  const fromCfg = cfg.automation || {}, fromState = loadState().auto || {};
  const out = {};
  for (const g of Object.keys(def)) out[g] = Object.assign({}, def[g], fromCfg[g], fromState[g]);
  return out;
}

let offlineSince = null, restartTimes = [], autoBusy = false, lastDailyDay = '', backingUp = false;



// ------------------------------------------------------------------ file watcher: log what changed on disk
let sigs = null;
function treeSig(root, cap) {
  let n = 0, newest = 0, newestFile = '', size = 0;
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) {
      if (n >= cap) return;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') w(path.join(d, e.name)); continue; }
      let st; try { st = fs.statSync(path.join(d, e.name)); } catch (_) { continue; }
      n++; size += st.size; if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(root, path.join(d, e.name)).split(path.sep).join('/'); }
    }
  })(root);
  return { n, newest, newestFile, size };
}
let watchGen = 0;
function watchTick(quiet) {
  watchGen++;
  const next = {};
  for (const f of (cfg.watchFiles || ['server.jsonc', 'acl.jsonc', 'ChoomVille_Secrets.cmd', 'ChoomVille_Start.bat', 'ChoomVille_Start_Logged.bat', 'Clean_Database.bat'])) {
    try { const st = fs.statSync(path.join(serverDir(), f)); next['file:' + f] = { sig: st.size + ':' + Math.round(st.mtimeMs), label: f }; } catch (_) { next['file:' + f] = { sig: 'missing', label: f }; }
  }
  let text = ''; try { text = fs.readFileSync(serverJsonc(), 'utf8'); } catch (_) { /* unreadable */ }
  const p = text ? parseLoad(text) : null;
  if (p) for (const i of p.items) if (i.kind === 'entry') {
    const t = treeSig(path.join(resourcesDir(), i.path), 40000);
    next['res:' + i.path] = { sig: t.n + ':' + t.size + ':' + Math.round(t.newest), label: i.path, newest: t.newestFile, n: t.n };
  }
  return watchApply(next, quiet);
}
function watchApply(next, quiet) {
  if (sigs && !quiet) {
    for (const k of Object.keys(next)) {
      const o = sigs[k], c = next[k];
      if (!o) { if (k.startsWith('res:')) logChange('resource.new', 'Resource in load list: ' + c.label, { ok: true }); continue; }
      if (o.sig !== c.sig) {
        if (k.startsWith('res:')) logChange('resource.change', 'Resource files changed: ' + c.label + (c.newest ? ' (newest: ' + c.newest + ')' : '') + (o.n !== c.n ? ' [' + o.n + ' -> ' + c.n + ' files]' : ''), { ok: true });
        else logChange('file.change', c.label + (c.sig === 'missing' ? ' was deleted' : o.sig === 'missing' ? ' was created' : ' was modified'), { ok: true });
      }
    }
    for (const k of Object.keys(sigs)) if (!next[k] && k.startsWith('res:')) logChange('resource.removed', 'Resource left the load list: ' + sigs[k].label, { ok: true });
  }
  sigs = next;
}
let backupsCache = [];

// ------------------------------------------------------------------ updates: server zip, opx, resource packs
// A zip is unpacked into a work folder, checked, compared file by file with what is installed, and only then applied.
// Rule per file (3-way): not there -> add | same -> nothing | untouched since the last install -> overwrite |
// you edited it and the release did not change it -> keep yours | you edited it AND the release changed it -> conflict:
// your file stays, the new one is saved next to it as <name>.NEW-<version>. Nothing is ever deleted. Every overwritten
// file is copied to backups/updates/<id>/files first, so an update can be rolled back.
const DEFAULT_PROTECT = ['server.jsonc', 'acl.jsonc', 'access.json', '.open77/', 'logs/', 'backups/', 'choomville_*', 'clean_database.bat', 'create_database.sql', 'warden_login.bat', 'resources/choomville/', 'resources/choomville-ui/', 'resources/cv_*'];
function updCfg() {
  const u = cfg.update || {};
  return { dirs: (u.dirs && u.dirs.length) ? u.dirs : ['updates'], keep: u.keepRollbacks || 5, requireDbBackup: u.requireDbBackup !== false, protect: u.protect || DEFAULT_PROTECT, packs: u.packs || [] };
}
const updDirs = () => updCfg().dirs.map((d) => path.resolve(dashDir(), d));
const updWork = () => path.join(dashDir(), 'work');
const updState = () => path.join(dashDir(), 'updstate');
const updBackups = () => path.join(backupsDir(), 'updates');
const posix = (p) => p.split(path.sep).join('/');
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const verNums = (v) => (String(v || '').match(/\d+/g) || []).map(Number);
function cmpVer(a, b) {
  const x = verNums(a), y = verNums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function isProtected(rel) {
  const r = posix(rel).toLowerCase();
  for (const raw of updCfg().protect) {
    const p = String(raw).toLowerCase();
    if (p.endsWith('/')) { if (r.startsWith(p) || r === p.slice(0, -1)) return true; }
    else if (p.endsWith('*')) { if (r.startsWith(p.slice(0, -1))) return true; }
    else if (r === p) return true;
  }
  return false;
}
function walkFiles(root) {
  const out = [];
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) {
      if (e.name === '.git' || e.name === '.github' || e.name === 'node_modules' || e.name === '__MACOSX') continue;
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) w(f); else if (e.isFile()) out.push(posix(path.relative(root, f)));
    }
  })(root);
  return out;
}
function hasSymlink(root) {
  let found = false;
  (function w(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of es) { if (found) return; const f = path.join(d, e.name); if (e.isSymbolicLink()) { found = true; return; } if (e.isDirectory()) w(f); } })(root);
  return found;
}
function actBegin(label) { const id = ++actionSeq; const a = actorNow(); emit('action', { id, state: 'start', label, by: a.type === 'person' ? a.name : '', type: a.type }); progStart('a' + id, label); return id; }
const actLn = (id, line) => { emit('action', { id, state: 'line', line }); if (!/^\d+%/.test(String(line))) progSet('a' + id, { text: String(line).slice(0, 200) }); };
const actEnd = (id, code, label) => { emit('action', { id, state: 'end', code, label }); progEnd('a' + id, code === 0); };
const actProg = (id, patch) => progSet('a' + id, patch);

let manifestCache = { mtime: 0, ver: null };
function installedServerVersion() {
  const f = path.join(serverDir(), 'package-manifest.json');
  try { const st = fs.statSync(f); if (st.mtimeMs !== manifestCache.mtime) manifestCache = { mtime: st.mtimeMs, ver: readJson(f).version || null }; return manifestCache.ver; }
  catch (_) { return null; }
}
function installedServerBaseline() {
  try { const m = readJson(path.join(serverDir(), 'package-manifest.json')); const o = {}; for (const f of m.files || []) o[f.path] = f.sha256; return o; }
  catch (_) { return {}; }
}
const packState = (id) => readJson(path.join(updState(), id + '.json'), null);
function savePackState(id, obj) { fs.mkdirSync(updState(), { recursive: true }); atomicWrite(path.join(updState(), id + '.json'), JSON.stringify(obj)); }
function packById(id) { return updCfg().packs.find((p) => p.id === id); }

function findZips(pack) {
  let re; try { re = new RegExp(pack.pattern || '^$', 'i'); } catch (_) { return []; }
  const out = [];
  for (const dir of updDirs()) {
    let names = []; try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      const m = n.match(re); if (!m) continue;
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch (_) { continue; }
      if (!st.isFile()) continue;
      out.push({ name: n, file: f, size: st.size, mtime: st.mtimeMs, version: pack.kind === 'server' ? (m[1] || null) : null });
    }
  }
  out.sort((a, b) => (pack.kind === 'server' && a.version && b.version && cmpVer(a.version, b.version)) ? cmpVer(b.version, a.version) : b.mtime - a.mtime);
  return out;
}
function listUpdateJournals() {
  const dir = updBackups(); let names = []; try { names = fs.readdirSync(dir).sort().reverse(); } catch (_) { return []; }
  const out = [];
  for (const n of names) { const j = readJson(path.join(dir, n, 'journal.json'), null); if (j) out.push(j); }
  return out;
}
function updOverview() {
  const js = listUpdateJournals();
  const live = new Set(); for (const j of js) { if (j.status === 'done' && !live.has(j.pack)) { live.add(j.pack); j.canRollback = true; } }
  return {
    autoDownload: (cfg.update || {}).autoDownload !== false, autoApply: autoCfg().apply, logFile: updLogFile(),
    dirs: updDirs(),
    packs: updCfg().packs.map((p) => {
      const zips = findZips(p), ps = p.kind === 'server' ? null : packState(p.id);
      const psrc = packSource(p), pdl = readJson(dlStateFile(p.id), null);
      return { id: p.id, label: p.label || p.id, kind: p.kind, hasUrl: !!p.url || !!psrc, source: psrc ? psrc.repo : '', sourceBranch: psrc ? psrc.branch : '', canSource: p.kind !== 'server', dl: pdl ? { sha: String(pdl.sha || '').slice(0, 7), at: pdl.at, file: pdl.file, branch: pdl.branch } : null,
        installed: p.kind === 'server' ? installedServerVersion() : (ps ? 'from ' + ps.zip : null),
        zips: zips.slice(0, 6).map((z) => ({ name: z.name, size: z.size, mtime: z.mtime, version: z.version })) };
    }),
    history: js.slice(0, 8).map((j) => ({ id: j.id, label: j.label, from: j.from, to: j.to, at: j.at, status: j.status, canRollback: !!j.canRollback, counts: j.counts })),
  };
}

async function extractZip(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  const env = Object.assign({}, process.env, { VNR_ZIP: zip, VNR_DEST: dest });
  const tries = IS_WIN
    ? [['tar.exe', ['-xf', zip, '-C', dest]], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:VNR_ZIP -DestinationPath $env:VNR_DEST -Force']]]
    : [['unzip', ['-q', '-o', zip, '-d', dest]], ['bsdtar', ['-xf', zip, '-C', dest]], ['python3', ['-m', 'zipfile', '-e', zip, dest]]];
  let last = '';
  for (const [exe, args] of tries) {
    jobCheck();
    const r = await execP(exe, args, { timeout: 600000, maxBuffer: 16 << 20, env, track: true, log: 'Unpack ' + path.basename(zip) });
    jobCheck();
    if (!r.err) {
      if (hasSymlink(dest)) return { ok: false, error: 'The zip contains symbolic links - refusing to use it.' };
      return { ok: true };
    }
    last = exe + ': ' + String(r.stderr || r.err.message).trim().split('\n').slice(-1)[0];
    fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  }
  return { ok: false, error: 'Could not unpack the zip (' + last + ').' };
}
function findRoot(dir, marker) {
  for (let i = 0; i < 3; i++) {
    if (marker && fs.existsSync(path.join(dir, marker))) return dir;
    const es = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX');
    if (es.length === 1 && es[0].isDirectory()) { dir = path.join(dir, es[0].name); continue; }
    return marker ? null : dir;
  }
  return marker ? (fs.existsSync(path.join(dir, marker)) ? dir : null) : dir;
}

// line-based three-way merge (diff3). ours/theirs are changes against base. Returns { clean, text, conflicts }.
function lcsPairs(a, b) {
  const n = a.length, m = b.length, map = new Array(n).fill(-1);
  let s = 0; while (s < n && s < m && a[s] === b[s]) { map[s] = s; s++; }
  let ea = n, eb = m; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; map[ea] = eb; }
  const N = ea - s, M = eb - s;
  if (N > 0 && M > 0) {
    if (N * M > 36e6 || Math.min(N, M) > 65000) return null;
    const w = M + 1, t = new Uint16Array((N + 1) * w);
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--)
      t[i * w + j] = a[s + i] === b[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (a[s + i] === b[s + j]) { map[s + i] = s + j; i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++; else j++;
    }
  }
  return map;
}
function merge3(baseT, oursT, theirsT) {
  const B = baseT.split('\n'), O = oursT.split('\n'), T = theirsT.split('\n');
  const mo = lcsPairs(B, O), mt = lcsPairs(B, T);
  if (!mo || !mt) return { clean: false, text: null, conflicts: -1, why: 'file too large to merge safely' };
  const out = []; let conflicts = 0, k0 = -1, o0 = -1, t0 = -1;
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const chunk = (k, o, t) => {
    const b = B.slice(k0 + 1, k), oo = O.slice(o0 + 1, o), tt = T.slice(t0 + 1, t);
    if (same(oo, b)) out.push(...tt); else if (same(tt, b) || same(oo, tt)) out.push(...oo); else { conflicts++; out.push(...oo); }
  };
  for (let k = 0; k < B.length; k++) {
    if (mo[k] < 0 || mt[k] < 0 || mo[k] <= o0 || mt[k] <= t0) continue;
    chunk(k, mo[k], mt[k]); out.push(B[k]); k0 = k; o0 = mo[k]; t0 = mt[k];
  }
  chunk(B.length, O.length, T.length);
  return { clean: conflicts === 0, text: out.join('\n'), conflicts };
}

// ---- patch guard: keeps the files ChoomVille patched outside resources/choomville, and puts them back (or merges) after an update ----
// Stored in <updates folder>/patches: registry.json, files/<rel> (our version), base/<rel> (the upstream file we patched, when it could be recovered).
// A file counts as patched when it differs from what the zip shipped (server: package-manifest.json; folder packs: the state saved at the last update),
// or when we added it (resources/system and the folder packs' own folders). resources/choomville is never touched by updates, so it is not listed.
const patchRoot = () => path.join(updDirs()[0], 'patches');
const patchReg = () => readJson(path.join(patchRoot(), 'registry.json'), { saved: 0, files: {} });
const patchWrite = (reg) => { fs.mkdirSync(patchRoot(), { recursive: true }); atomicWrite(path.join(patchRoot(), 'registry.json'), JSON.stringify(reg, null, 1)); };
const patchOurs = (rel) => path.join(patchRoot(), 'files', rel);
const patchBase = (rel) => path.join(patchRoot(), 'base', rel);

const tick = () => new Promise((r) => setImmediate(r));
function shaOrNull(f) { try { return sha256File(f); } catch (_) { return null; } }
function copyInto(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }



// copy the upstream originals of patched files out of the zip that is installed now (verified by sha against the manifest/state)






// After an update (journal given) or by hand (no journal). Only an update's own journal says "this file was replaced by the release", so by hand
// a file that differs from the saved copy is reported, never overwritten (it may be newer than the snapshot).
async function patchReapply(opts) {
  const j = opts && opts.journal, jdir = opts && opts.jdir, reg = patchReg(), sd = serverDir(), res = [];
  const replaced = new Set(j ? (j.overwritten || []) : []);
  const backup = (rel, live) => { if (!j) return; const b = path.join(jdir, 'files', rel); if (!fs.existsSync(b)) { copyInto(live, b); } if (!(j.overwritten || []).includes(rel)) (j.overwritten = j.overwritten || []).push(rel); };
  let n = 0;
  for (const [rel, e] of Object.entries(reg.files)) {
    if (++n % 40 === 0) await tick();
    const live = path.join(sd, rel), ours = patchOurs(rel);
    const oursSha = shaOrNull(ours);
    if (oursSha === null) { res.push({ rel, state: 'nostore', note: 'no saved copy' }); continue; }
    const liveSha = shaOrNull(live);
    let newCopy = null;
    try { const dir = path.dirname(live), bn = path.basename(live); const c = fs.readdirSync(dir).filter((x) => x.startsWith(bn + '.NEW-')).map((x) => path.join(dir, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); newCopy = c[0] || null; } catch (_) { /* none */ }
    const baseTxt = e.hasBase ? (() => { try { return fs.readFileSync(patchBase(rel), 'utf8'); } catch (_) { return null; } })() : null;
    const tryMerge = (theirsText) => {
      if (baseTxt === null) return { clean: false, why: 'the original it was patched from is not saved' };
      let oursTxt; try { oursTxt = fs.readFileSync(ours, 'utf8'); } catch (_) { return { clean: false, why: 'unreadable' }; }
      if (oursTxt.includes('\u0000') || theirsText.includes('\u0000')) return { clean: false, why: 'binary file' };
      return merge3(baseTxt, oursTxt, theirsText);
    };
    const adopt = (mergedText, theirsFile, theirsSha) => {
      if (fs.existsSync(live)) backup(rel, live);
      copyInto(ours, path.join(patchRoot(), 'history', stampNow(), rel));
      fs.mkdirSync(path.dirname(live), { recursive: true }); fs.writeFileSync(live, mergedText);
      copyInto(live, ours); e.sha = sha256File(live);
      if (theirsSha) { e.base = theirsSha; try { copyInto(theirsFile, patchBase(rel)); e.hasBase = true; } catch (_) { e.hasBase = false; } }
    };
    if (liveSha === null) { copyInto(ours, live); res.push({ rel, state: 'restored', note: 'was missing' }); continue; }
    if (liveSha === oursSha) {
      if (!newCopy) { res.push({ rel, state: 'intact' }); continue; }
      const tTxt = fs.readFileSync(newCopy, 'utf8'), m = tryMerge(tTxt);
      if (m.clean) { adopt(m.text, newCopy, sha256File(newCopy)); fs.rmSync(newCopy, { force: true }); res.push({ rel, state: 'merged', note: 'update and our patch combined without overlap' }); }
      else res.push({ rel, state: 'needsmerge', note: m.why || (m.conflicts + ' overlapping change(s)'), copy: posix(path.relative(sd, newCopy)) });
      continue;
    }
    if (e.base && liveSha === e.base) { copyInto(ours, live); res.push({ rel, state: 'restored', note: 'the patch had been lost; original upstream file was in place' }); continue; }
    if (j && replaced.has(rel)) {
      const tTxt = fs.readFileSync(live, 'utf8'), m = tryMerge(tTxt);
      if (m.clean) { const tsha = liveSha; const tmp = path.join(patchRoot(), 'tmp_theirs'); copyInto(live, tmp); adopt(m.text, tmp, tsha); fs.rmSync(tmp, { force: true }); res.push({ rel, state: 'merged', note: 'the update replaced the file; the patch was merged back in' }); }
      else {
        const nn = newName(live, j.to); copyInto(live, nn); (j.newFiles = j.newFiles || []).push(posix(path.relative(sd, nn)));
        backup(rel, live); copyInto(ours, live);
        res.push({ rel, state: 'needsmerge', note: (m.why || (m.conflicts + ' overlapping change(s)')) + ' - our patched file was put back; the new upstream file is saved beside it', copy: posix(path.relative(sd, nn)) });
      }
      continue;
    }
    res.push({ rel, state: 'changed', note: 'differs from the saved copy (edited since the last snapshot?) - press Save patched files to keep it' });
  }
  patchWrite(reg);
  const counts = {}; for (const r of res) counts[r.state] = (counts[r.state] || 0) + 1;
  return { results: res, counts };
}

// ---- what an update changed, readable (built from the journal, so older updates get a report too) ----
const resGroup = (rel) => {
  const p = posix(rel).split('/');
  if (p[0].toLowerCase() === 'resources' && p.length > 2) return ['system', 'choomville', 'gamemodes'].includes(p[1].toLowerCase()) && p.length > 3 ? p[1] + '/' + p[2] : p[1];
  return p.length > 1 ? p[0] : '(server root)';
};
function luaVersion(f) { try { const m = fs.readFileSync(f, 'utf8').match(/^\s*version\s*\(?\s*["']([^"']+)["']/m); return m ? m[1] : null; } catch (_) { return null; } }
function buildReport(j) {
  const groups = {};
  const G = (rel) => { const k = resGroup(rel); return groups[k] || (groups[k] = { name: k, added: [], replaced: [], conflicts: [] }); };
  for (const r of j.added || []) G(r).added.push(r);
  for (const r of j.overwritten || []) G(r).replaced.push(r);
  for (const r of j.newFiles || []) { const orig = r.replace(/\.NEW-[^\/]*$/, ''); G(orig).conflicts.push({ file: orig, copy: r }); }
  for (const k of Object.keys(groups)) { const v = (j.versions || {})[k]; if (v) { groups[k].verFrom = v.from || null; groups[k].verTo = v.to || null; } }
  const merged = new Set((j.patches || []).filter((x) => x.state === 'merged').map((x) => x.rel));
  for (const g of Object.values(groups)) g.conflicts = g.conflicts.filter((x) => !merged.has(x.file));
  const list = Object.values(groups).sort((a, b) => (b.conflicts.length - a.conflicts.length) || a.name.localeCompare(b.name));
  return { groups: list, removed: j.removed || [], warnings: j.warnings || [], hasVersions: !!j.versions, patches: j.patches || [], patchCounts: j.patchCounts || null, patchError: j.patchError || null };
}
function reportText(j, rep) {
  const c = j.counts || {}, L = [];
  L.push('UPDATE REPORT - ' + j.label + ' ' + j.from + ' -> ' + j.to + '  (' + new Date(j.at).toLocaleString() + ', ' + j.status + ')');
  const nm = rep.groups.reduce((a, g) => a + g.conflicts.length, 0);
  L.push('Files: ' + (j.added || []).length + ' added, ' + (j.overwritten || []).length + ' replaced, ' + nm + ' still need a merge (your patched file stayed; the new upstream copy was saved next to it as .NEW-' + j.to + '), ' + (c.keep || 0) + ' of yours kept (upstream did not change them).');
  for (const w of rep.warnings) L.push('NOTE: ' + w);
  for (const g of rep.groups) {
    L.push('');
    L.push('== ' + g.name + (g.verFrom || g.verTo ? '   version ' + (g.verFrom || '?') + ' -> ' + (g.verTo || '?') : '') + ' ==');
    for (const x of g.conflicts) L.push('  NEEDS MERGE  ' + x.file + '   (new upstream copy: ' + x.copy + ')');
    const cap = (arr, tag) => { arr.slice(0, 60).forEach((f) => L.push('  ' + tag + f)); if (arr.length > 60) L.push('  ... and ' + (arr.length - 60) + ' more ' + tag.trim()); };
    cap(g.replaced, 'replaced     '); cap(g.added, 'added        ');
  }
  if (rep.patchCounts || rep.patchError) {
    L.push(''); L.push('== YOUR PATCHED FILES (patch guard) ==');
    if (rep.patchError) L.push('  PROBLEM: ' + rep.patchError);
    if (rep.patchCounts) L.push('  ' + Object.entries(rep.patchCounts).map(([k, v]) => v + ' ' + k).join(', '));
    for (const x of rep.patches) L.push('  ' + String(x.state).toUpperCase().padEnd(11) + x.rel + (x.note ? '   - ' + x.note : '') + (x.copy ? '   (new upstream copy: ' + x.copy + ')' : ''));
  }
  if (rep.removed.length) { L.push(''); L.push('No longer shipped upstream (left in place, not deleted): ' + rep.removed.slice(0, 40).join(', ') + (rep.removed.length > 40 ? ' ... +' + (rep.removed.length - 40) + ' more' : '')); }
  L.push('');
  L.push('NEEDS MERGE files are the ones you patched where the update also changed the same file. Everything else was replaced cleanly. Send this report to Claude to merge and re-check.');
  return L.join('\n');
}

const plans = new Map();
function classify3(dest, newSha, base) {
  let st; try { st = fs.statSync(dest); } catch (_) { return 'add'; }
  if (!st.isFile()) return 'blocked';
  const dh = sha256File(dest);
  if (dh === newSha) return 'same';
  if (base === undefined) return 'conflict';
  if (dh === base) return 'overwrite';
  return base === newSha ? 'keep' : 'conflict';
}
async function makePlan(packId, zipName, K) {
  const pack = packById(packId);
  if (!pack) return { ok: false, error: 'unknown update pack' };
  const zips = findZips(pack);
  const z = zipName ? zips.find((x) => x.name === zipName) : zips[0];
  if (!z) return { ok: false, error: 'No ' + (pack.label || pack.id) + ' zip found. Put it in ' + updDirs()[0] };
  const work = path.join(updWork(), pack.id);
  if (K) progStage(K, 'Unpacking ' + z.name, 1, 2);
  const ex = await extractZip(z.file, work);
  if (!ex.ok) return ex;
  if (K) progStage(K, 'Checking every file against the zip', 2, 2);
  const problems = [], warnings = [], notes = [];
  const sd = serverDir();
  let items = [], baseline = {}, removed = [], available = [], newVer = '', oldVer = '', root;
  if (pack.kind === 'server') {
    root = findRoot(work, 'package-manifest.json');
    if (!root) return { ok: false, error: 'This zip has no package-manifest.json - it is not an Open77 server release.' };
    const man = readJson(path.join(root, 'package-manifest.json'));
    newVer = man.version || z.version || 'new'; oldVer = installedServerVersion() || 'none';
    if (IS_WIN && man.runtime && man.runtime !== 'win-x64') problems.push('This is a ' + man.runtime + ' build; this PC needs win-x64.');
    if (oldVer !== 'none' && cmpVer(newVer, oldVer) < 0) problems.push('This release (' + newVer + ') is OLDER than the installed one (' + oldVer + '). Use Roll back instead.');
    if (!pack.allowPreview && /unstable|preview|nightly|beta|-rc\d*/i.test(z.name + ' ' + newVer)) problems.push('This looks like a preview/unstable build. Open77 says never to put one on a live server (set allowPreview in dashboard.json to override).');
    if (man.clientVersion) warnings.push('Players must update their game client to ' + man.clientVersion + '.');
    baseline = installedServerBaseline();
    let bad = 0;
    let hn = 0; const htotal = (man.files || []).length;
    for (const f of man.files || []) {
      if (f.path === 'package-manifest.json') continue;
      if (K) { hn++; if (hn % 25 === 0) { jobCheck(); progSet(K, { done: hn, total: htotal, unit: 'files' }); await new Promise((r) => setImmediate(r)); } }
      const src = path.join(root, f.path);
      let ok = false; try { ok = sha256File(src) === f.sha256; } catch (_) { ok = false; }
      if (!ok) { bad++; if (bad <= 10) problems.push('Damaged or missing in the zip: ' + f.path); }
      items.push({ key: f.path, destRel: f.path, src, sha: f.sha256 });
    }
    if (bad > 10) problems.push('... and ' + (bad - 10) + ' more damaged files. Download the zip again.');
    const keys = new Set(items.map((i) => i.key));
    removed = Object.keys(baseline).filter((k) => !keys.has(k) && k !== 'package-manifest.json');
    items.push({ key: 'package-manifest.json', destRel: 'package-manifest.json', src: path.join(root, 'package-manifest.json'), sha: sha256File(path.join(root, 'package-manifest.json')), last: true });
    baseline['package-manifest.json'] = undefined;
    const bm = path.join(sd, 'package-manifest.json'); if (fs.existsSync(bm)) baseline['package-manifest.json'] = sha256File(bm);
  } else {
    root = findRoot(work, null);
    const files = walkFiles(root);
    const ps = packState(pack.id); baseline = ps ? ps.files : {};
    oldVer = ps ? ps.zip : 'none'; newVer = z.name;
    if (!ps) notes.push('First update of this pack from here: any file that already exists and differs is treated as yours and kept; the new one is saved beside it as .NEW.');
    if (pack.kind === 'folder') {
      const target = String(pack.target || '');
      const tdir = path.resolve(sd, target);
      if (!target || !(tdir + path.sep).startsWith(path.resolve(sd) + path.sep) || tdir === path.resolve(sd)) return { ok: false, error: 'pack "' + pack.id + '": target must be a folder inside the server folder' };
      if (!files.includes('open77.lua')) warnings.push('No open77.lua at the top of this zip - is it the right pack?');
      if (!fs.existsSync(tdir)) notes.push('Not installed yet - this installs it fresh into ' + target + '.');
      for (const rel of files) items.push({ key: rel, destRel: posix(path.join(target, rel)), src: path.join(root, rel), sha: sha256File(path.join(root, rel)) });
    } else if (pack.kind === 'resources') {
      const skip = new Set((pack.skip || ['system']).map((s) => s.toLowerCase()));
      const rroot = cfg.server.resourcesRoot || 'resources';
      const roots = files.filter((f) => f.endsWith('/open77.lua')).map((f) => f.slice(0, -'/open77.lua'.length)).filter((r) => r && !skip.has(r.split('/')[0].toLowerCase())).sort((a, b) => b.length - a.length);
      const instOf = {};
      for (const r of roots) {
        const cand = [posix(path.join(rroot, r)), posix(path.join(rroot, path.basename(r)))];
        const hit = cand.find((c) => { try { return fs.statSync(path.join(sd, c)).isDirectory(); } catch (_) { return false; } });
        if (hit) instOf[r] = hit; else available.push(r);
      }
      for (const rel of files) {
        const r = roots.find((x) => rel.startsWith(x + '/')); if (!r || !instOf[r]) continue;
        items.push({ key: rel, destRel: posix(path.join(instOf[r], rel.slice(r.length + 1))), src: path.join(root, rel), sha: sha256File(path.join(root, rel)) });
      }
      notes.push('Only resources you already have are updated (' + Object.keys(instOf).length + ' found). The platform "system" folder is skipped: the server zip owns it.');
      if (!Object.keys(instOf).length) notes.push('None of the resources in this pack are installed in ' + rroot + '.');
    }
    const keys = new Set(items.map((i) => i.key));
    removed = Object.keys(baseline).filter((k) => !keys.has(k));
  }
  const counts = { add: 0, overwrite: 0, same: 0, keep: 0, conflict: 0, protected: 0, blocked: 0 };
  for (const it of items) {
    it.dest = path.join(sd, it.destRel);
    it.action = isProtected(it.destRel) ? 'protected' : classify3(it.dest, it.sha, baseline[it.key]);
    counts[it.action]++;
    if (it.action === 'blocked') problems.push('A folder is in the way of the file ' + it.destRel);
  }
  const id = 'p' + Date.now().toString(36);
  const plan = { id, pack, zip: z, work, root, items, counts, problems, warnings, notes, removed, available, newVer, oldVer, created: Date.now() };
  for (const [k, v] of plans) if (v.pack.id === pack.id || Date.now() - v.created > 3600000) plans.delete(k);
  plans.set(id, plan);
  const rows = items.filter((i) => i.action !== 'same').map((i) => ({ rel: i.destRel, action: i.action }));
  return { ok: true, backup: backupCoverage(), planId: id, pack: pack.id, label: pack.label || pack.id, kind: pack.kind, zip: z.name, from: oldVer, to: newVer, counts, rows: rows.slice(0, 400), rowsMore: Math.max(0, rows.length - 400), removed: removed.slice(0, 40), removedMore: Math.max(0, removed.length - 40), available: available.slice(0, 40), problems, warnings, notes, canApply: problems.length === 0, needsStop: true };
}

const newName = (p, ver) => p + '.NEW-' + String(ver).replace(/[^\w.-]/g, '_');
function undoJournal(j, jdir, sd, reason) {
  const errs = [];
  for (const rel of j.overwritten || []) { try { const b = path.join(jdir, 'files', rel); if (fs.existsSync(b)) fs.copyFileSync(b, path.join(sd, rel)); } catch (e) { errs.push(rel + ': ' + e.message); } }
  for (const rel of (j.added || []).concat(j.newFiles || [])) { try { fs.rmSync(path.join(sd, rel), { force: true }); } catch (e) { errs.push(rel + ': ' + e.message); } }
  if (j.pack !== 'server' || true) {
    try { const sp = path.join(updState(), j.pack + '.json'); if (j.stateBefore) atomicWrite(sp, JSON.stringify(j.stateBefore)); else if (j.kind !== 'server') fs.rmSync(sp, { force: true }); } catch (e) { errs.push('state: ' + e.message); }
  }
  return errs;
}
// every update (automatic or by button) writes an entry to update_log.md next to dashboard.json: readable by people and by Claude
const updLogFile = () => path.join(dashDir(), 'update_log.md');
function writeUpdateLog(entry) {
  try {
    const f = updLogFile();
    try { if (fs.statSync(f).size > (1 << 20)) fs.renameSync(f, f.replace(/\.md$/, '.1.md')); } catch (_) { /* new file */ }
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# Update log\n\nWritten by the VNR Launcher after every update check, download and install (newest at the bottom). Each entry says what changed, where the backup is, and how to undo it.\n');
    const L = [], at = new Date(), pad = (n) => String(n).padStart(2, '0');
    L.push('', '## ' + at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + ' - ' + entry.pack + ' - ' + entry.status + (entry.how ? ' (' + entry.how + ')' : ''));
    if (entry.source) L.push('- Source: ' + entry.source);
    if (entry.version) L.push('- Version: ' + entry.version);
    if (entry.zip) L.push('- Zip: ' + entry.zip);
    if (entry.result) L.push('- Result: ' + entry.result);
    if (entry.counts) L.push('- Files: ' + entry.counts.add + ' added, ' + entry.counts.overwrite + ' replaced, ' + (entry.counts.keep || 0) + ' kept (yours), ' + (entry.counts.conflict || 0) + ' conflicts (new copy saved beside yours as .NEW-)');
    if (entry.journal) L.push('- Undo: Updates page > Roll back (update id ' + entry.journal + '), or restore the full backup named in the result.');
    const list = (title, arr) => { if (arr && arr.length) { L.push('', '### ' + title + ' (' + arr.length + ')'); for (const x of arr.slice(0, 150)) L.push('- ' + x); if (arr.length > 150) L.push('- ... +' + (arr.length - 150) + ' more'); } };
    list('What upstream changed (commit messages)', entry.commits);
    list('Files changed on GitHub between the two versions', entry.upstreamFiles);
    list('Added on this server', entry.added);
    list('Replaced on this server', entry.overwritten);
    list('Conflicts: your version kept, the new one saved beside it', entry.newFiles);
    list('Your patched files after the update', entry.patches);
    list('Version lines (open77.lua)', entry.versions);
    list('Warnings and problems', entry.warnings);
    L.push('');
    fs.appendFileSync(f, L.join('\n'));
  } catch (_) { /* a log problem must never stop an update */ }
}
async function applyPlan(planId, body) {
  const plan = plans.get(planId);
  const meta = plan ? { pack: (plan.pack.label || plan.pack.id), version: plan.oldVer + ' -> ' + plan.newVer, zip: plan.zip && plan.zip.name, counts: plan.counts, warnings: plan.warnings || [], how: (body && body.auto) ? 'automatic' : 'by button' } : null;
  const r = await applyPlanCore(planId, body);
  if (meta) {
    const e = Object.assign({}, meta, { status: r.ok ? 'INSTALLED' : 'FAILED', result: r.ok ? r.note : r.error });
    if (r.ok && r.journal) {
      const j = readJson(path.join(updBackups(), r.journal, 'journal.json'), null);
      if (j) Object.assign(e, { journal: j.id, added: j.added, overwritten: j.overwritten, newFiles: j.newFiles, patches: (j.patches || []).map((x) => x.state + ' ' + x.rel + (x.note ? ' - ' + x.note : '')), versions: Object.entries(j.versions || {}).map(([k, v]) => k + ': ' + (v.from || '?') + ' -> ' + (v.to || '?')) });
    }
    if (body && body.sourceInfo) Object.assign(e, body.sourceInfo);
    writeUpdateLog(e);
  }
  return r;
}
async function applyPlanCore(planId, body) {
  const plan = plans.get(planId);
  if (!plan) return { ok: false, error: 'This check has expired - press Check again.' };
  if (plan.problems.length) return { ok: false, error: 'Fix the problems first: ' + plan.problems[0] };
  if (plan.pack.kind === 'server' && body.confirm !== true) return { ok: false, error: 'Press the Update button to confirm.' };
  const sd = serverDir(), pk = plan.pack, label = pk.label || pk.id;
  const cov = backupCoverage(), wantBackup = !!(body && body.backup === true);
  if (!cov.fresh && !wantBackup && !(body && (body.skipBackup === true || body.auto))) return { ok: false, needBackup: true, coverage: cov, error: cov.text + ' Choose: back up first, or update without a backup.' };
  const aid = actBegin('Update ' + label + ': ' + plan.oldVer + ' -> ' + plan.newVer);
  const fail = (msg) => { logChange('update.apply', label + ' update FAILED: ' + msg, { ok: false }); actLn(aid, 'FAILED: ' + msg); actEnd(aid, 1, label); return { ok: false, error: msg }; };
  updating = true;
  let phase = 'before';        // before = nothing changed yet; applying = files are being changed (a stop undoes them); finishing = cannot be stopped
  try {
    if (busy.has('server')) return fail('The server is starting or stopping - wait a moment.');
    busy.add('server');
    try {
      const cur = await findServer();
      const K = 'a' + aid;
      progSet(K, { steps: 4 });
      if (cur.running) { actLn(aid, 'Stopping the server ...'); progStage(K, 'Stopping the server', 1, 4); const s = await serverStop('update'); if (!s.ok) return fail(s.error); }
      jobCheck();
      let fb = null;
      if (!wantBackup) {
        actLn(aid, 'Backup check: ' + cov.text);
        if (!cov.fresh) { logChange('update.nobackup', label + ' update installed WITHOUT a recent backup. ' + cov.text, { ok: false }); emit('alert', { level: 'warn', text: label + ' was updated without a recent backup.' }); }
      }
      if (wantBackup) {
      actLn(aid, 'Backing up config, scripts and database ...');
      progStage(K, 'Backing up config, scripts and the database', 2, 4);
      const bk = { ok: true, note: 'files only (Lite)', dbFile: null };
      backupsCache = listBackups();
      jobCheck();
      if (!bk.ok) {
        if (updCfg().requireDbBackup || !/atabase/.test(bk.error || '')) return fail('Backup failed, nothing was changed: ' + bk.error + (cur.running ? ' (The server is stopped.)' : ''));
        actLn(aid, 'WARNING: ' + bk.error);
      }
      actLn(aid, 'Backup done: ' + (bk.note || 'ok'));
      actLn(aid, 'Making the full, verified backup of the server files ...');
      fb = await backupFull('before ' + label + ' update', { dbFile: bk.dbFile || null, db: false, prog: K, stage: 'Full backup of the server files', step: 3, steps: 4 });
      fullCache = listFull();
      jobCheck();
      if (!fb.ok) return fail(fb.error + (cur.running ? ' (The server is stopped.)' : ''));
      actLn(aid, fb.note);
      }
      const jid = stampNow() + '_' + pk.id;
      const jdir = path.join(updBackups(), jid); fs.mkdirSync(path.join(jdir, 'files'), { recursive: true });
      const j = { id: jid, pack: pk.id, kind: pk.kind, label, from: plan.oldVer, to: plan.newVer, zip: plan.zip.name, at: Date.now(), status: 'applying', counts: plan.counts, added: [], overwritten: [], newFiles: [], stateBefore: pk.kind === 'server' ? null : packState(pk.id) };
      j.versions = {};
      for (const it of plan.items) if (/(^|\/)open77\.lua$/.test(it.destRel) && !['same', 'protected', 'keep'].includes(it.action)) j.versions[resGroup(it.destRel)] = { from: luaVersion(it.dest), to: luaVersion(it.src) };
      j.removed = (plan.removed || []).slice(0, 300); j.warnings = plan.warnings || [];
      const save = () => atomicWrite(path.join(jdir, 'journal.json'), JSON.stringify(j, null, 1));
      save();
      const todo = plan.items.filter((i) => ['add', 'overwrite', 'conflict'].includes(i.action)).sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
      actLn(aid, 'Applying ' + todo.length + ' file changes ...');
      progStage(K, 'Applying the update', 4, 4);
      phase = 'applying';
      let n = 0;
      try {
        for (const it of todo) {
          jobCheck();
          if (it.action === 'add') { fs.mkdirSync(path.dirname(it.dest), { recursive: true }); j.added.push(it.destRel); save(); fs.copyFileSync(it.src, it.dest); if (sha256File(it.dest) !== it.sha) throw new Error('verify failed for ' + it.destRel); }
          else if (it.action === 'overwrite') {
            const b = path.join(jdir, 'files', it.destRel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(it.dest, b);
            j.overwritten.push(it.destRel); save(); fs.copyFileSync(it.src, it.dest); if (sha256File(it.dest) !== it.sha) throw new Error('verify failed for ' + it.destRel);
          } else {
            const nn = newName(it.dest, plan.newVer); j.newFiles.push(posix(path.relative(sd, nn))); save(); fs.copyFileSync(it.src, nn);
          }
          ++n; actProg(aid, { done: n, total: todo.length, unit: 'files' });
          if (n % 40 === 0) await new Promise((r) => setImmediate(r));     // let the dashboard (and its Stop button) be heard
          if (n % 100 === 0) actLn(aid, n + ' / ' + todo.length);
        }
        if (pk.kind !== 'server') { const files = {}; for (const it of plan.items) if (it.action !== 'protected') files[it.key] = it.sha; savePackState(pk.id, { zip: plan.zip.name, at: Date.now(), files }); }
      } catch (e) {
        actLn(aid, (e && e.cancelled ? 'Stopped: ' : 'Error: ') + e.message + ' - undoing what was changed ...');
        const errs = undoJournal(j, jdir, sd);
        j.status = 'failed'; j.error = e.message; save();
        return fail(e.message + (errs.length ? ' (undo problems: ' + errs.join('; ') + ')' : ' - everything was put back as it was.'));
      }
      phase = 'finishing'; progSet(K, { stoppable: false, stopNote: 'Finishing safely: putting your patched files back. It stops itself in a moment.' }); emit('progress', { ev: 'set', p: progs.get(K) });
      try {
        actLn(aid, 'Putting your patched files back / merging them with the new release ...');
        const pr = await patchReapply({ journal: j, jdir });
        j.patches = pr.results.filter((x) => x.state !== 'intact'); j.patchCounts = pr.counts;
        actLn(aid, 'Patched files: ' + (Object.entries(pr.counts).map(([k, v]) => v + ' ' + k).join(', ') || 'none tracked') + '.');
        for (const x of j.patches) actLn(aid, '  ' + x.state.toUpperCase() + ' ' + x.rel + (x.note ? ' - ' + x.note : ''));
      } catch (e) { j.patchError = e.message; actLn(aid, 'WARNING: could not re-apply the patched files: ' + e.message); }
      j.status = 'done'; save();
      const keepN = updCfg().keep, names = (() => { try { return fs.readdirSync(updBackups()).sort(); } catch (_) { return []; } })();
      for (const nm of names.slice(0, Math.max(0, names.length - keepN))) { try { fs.rmSync(path.join(updBackups(), nm), { recursive: true, force: true }); } catch (_) { /* in use */ } }
      const c = plan.counts;
      const pc = j.patchCounts || {};
      const summary = label + ' ' + plan.oldVer + ' -> ' + plan.newVer + ': ' + c.add + ' added, ' + c.overwrite + ' replaced, ' + c.keep + ' kept yours, ' + c.conflict + ' conflicts' + (c.conflict ? ' (new copies saved as .NEW-)' : '') + '; patched files: ' + ((pc.merged || 0) + (pc.restored || 0)) + ' put back/merged, ' + (pc.needsmerge || 0) + ' need a merge';
      logChange('update.apply', summary, { ok: true, where: jid });
      actLn(aid, 'Done. ' + summary); actEnd(aid, 0, label);
      emit('alert', { level: 'ok', text: 'UPDATED: ' + summary + '. Start the server and read the log before players join.' });
      fs.rmSync(plan.work, { recursive: true, force: true }); plans.delete(planId);
      const ret = { ok: true, note: summary + (fb ? '. Full backup kept as ' + fb.name : '. No new backup was made (' + (wantBackup ? 'none needed' : cov.fresh ? 'a recent one exists' : 'you chose to update without one') + ')') + '. Start the server and read the log before players join.', journal: jid };
      if (body.startAfter) { busy.delete('server'); const s = await serverStart('update'); if (!s.ok) ret.note += ' (could not start: ' + s.error + ')'; busy.add('server'); }
      return ret;
    } finally { busy.delete('server'); }
  } catch (e) {
    if (e && e.cancelled) {
      const msg = e.message + (phase === 'before' ? '. Nothing was changed (the server may have been stopped - start it again if you need it).' : '.');
      logChange('update.apply', label + ' update STOPPED by ' + e.by + '. ' + (phase === 'before' ? 'Nothing was changed.' : ''), { ok: false });
      actLn(aid, msg); actEnd(aid, 1, label);
      return { ok: false, cancelled: true, error: msg };
    }
    throw e;
  } finally { updating = false; }
}


// optional: download the zip when a pack has a "url" in dashboard.json (https only; headers are only sent to the first host)

// ---- GitHub sources for update packs. Set per pack on the Updates page (stored in updstate/sources.json) or as "repo"/"branch" in dashboard.json.
const srcFile = () => path.join(updState(), 'sources.json');
function packSource(pack) {
  const o = (readJson(srcFile(), {}) || {})[pack.id] || {};
  const repo = String(o.repo || pack.repo || ''), branch = String(o.branch || pack.branch || '');
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? { repo, branch } : null;
}
const dlStateFile = (id) => path.join(updState(), 'dl_' + id + '.json');



// every pack that has a GitHub address or a link; never applies anything (applying stays a button press with a backup)

// ---- automatic cycle: ask GitHub, download what is new, back up, install it, write the log.
// Only installs when the plan is clean (no problems, no conflicts) and the server is off; anything else waits for you and is logged.

const autoCfg = () => { const u = cfg.update || {}; return { apply: u.autoApply !== false, whileRunning: u.autoApplyWhileRunning === true }; };


let updating = false;

// ------------------------------------------------------------------ FULL BACKUP for updating
// backups/full/<stamp>/   server/...  parent/...  db/<dump>.sql.gz  manifest.json (sha256 of every file)  summary.json
// It is built in <stamp>.partial and only renamed when every file was copied AND re-read and matched, so a half-made backup never looks valid.
const FULL_DEFAULT = {
  files: ['server.jsonc', 'acl.jsonc', 'ChoomVille_Secrets.cmd', 'ChoomVille_Start.bat', 'ChoomVille_Start_Logged.bat', 'Start.cmd', 'Warden_Login.bat', 'create_database.sql', 'package-manifest.json'],
  dirs: ['resources/choomville', 'resources/opx_infinity', 'resources/opx_lib', 'resources/system', '.open77', 'config', '../overlay'],
};
const fullDir = () => path.join(backupsDir(), 'full');
let fullCache = [];
function fullTargets() {
  const f = (cfg.backups && cfg.backups.full) || {};
  const out = [];
  const generic = () => { try { return fs.readdirSync(serverDir()).filter((x) => !/^(logs?|crash_?dumps|\.git|node_modules|backups)$/i.test(x)); } catch (_) { return []; } };
  const list = (f.files || f.dirs) ? (f.files || FULL_DEFAULT.files).concat(f.dirs || FULL_DEFAULT.dirs) : (f.all === true || typeof LITE !== 'undefined') ? generic() : FULL_DEFAULT.files.concat(FULL_DEFAULT.dirs);
  for (const n of list) {
    const s = String(n).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!s || /^[A-Za-z]:/.test(s) || s.startsWith('/')) continue;
    const outside = s.startsWith('../');
    const rel = outside ? s.slice(3) : s;
    if (!rel || rel.split('/').includes('..') || rel === '.') continue;
    out.push({ spec: s, base: outside ? 'parent' : 'server', rel });
  }
  return out;
}
const baseDirOf = (b) => (b === 'parent' ? path.dirname(serverDir()) : serverDir());
const relPath = (rel) => rel.split('/');
function sha256Async(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); const s = fs.createReadStream(file);
    s.on('data', (b) => h.update(b)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex')));
  });
}
function gzipCheck(file) {      // reads the whole dump through gunzip: valid gzip + ends like a finished mysqldump
  return new Promise((resolve) => {
    const zlib = require('zlib'); let tail = '', bytes = 0, bad = null;
    const gun = zlib.createGunzip();
    gun.on('data', (b) => { bytes += b.length; tail = (tail + b.toString('latin1')).slice(-400); });
    gun.on('error', (e) => { bad = e.message; resolve({ ok: false, error: bad }); });
    gun.on('end', () => resolve({ ok: bytes > 0, bytes, complete: /Dump completed/.test(tail), error: bytes > 0 ? '' : 'the dump is empty' }));
    fs.createReadStream(file).on('error', (e) => resolve({ ok: false, error: e.message })).pipe(gun);
  });
}
function pruneFull() {
  let names = []; try { names = fs.readdirSync(fullDir()).sort(); } catch (_) { return; }
  for (const n of names.filter((x) => x.endsWith('.partial'))) {
    try { if (Date.now() - fs.statSync(path.join(fullDir(), n)).mtimeMs > 3600000) fs.rmSync(path.join(fullDir(), n), { recursive: true, force: true }); } catch (_) { /* in use */ }
  }
  const keep = (cfg.backups && cfg.backups.keepFull) || 6;
  const done = names.filter((x) => !x.endsWith('.partial'));
  for (const n of done.slice(0, Math.max(0, done.length - keep))) { try { fs.rmSync(path.join(fullDir(), n), { recursive: true, force: true }); } catch (_) { /* in use */ } }
}
function listFull() {
  let names = []; try { names = fs.readdirSync(fullDir()).filter((n) => !n.endsWith('.partial')).sort().reverse(); } catch (_) { return []; }
  return names.slice(0, 8).map((n) => { const s = readJson(path.join(fullDir(), n, 'summary.json'), null); return s ? Object.assign({ name: n }, s) : { name: n, broken: true }; });
}
async function backupFull(reason, opt) {
  opt = opt || {};
  const name = stampNow() + (opt.tag ? '_' + opt.tag : '');
  const K = opt.prog || progStart('full' + name, 'Full backup (' + (reason || 'manual') + ')', { kind: 'backup' });
  const own = !opt.prog;
  if (!own) progStage(K, opt.stage || 'Full backup', opt.step, opt.steps);
  const part = path.join(fullDir(), name + '.partial'), final = path.join(fullDir(), name);
  const files = []; const missing = []; let bytes = 0;
  try {
    fs.mkdirSync(part, { recursive: true });
    progSet(K, { text: 'Counting files ...' });
    const jobs = [];
    for (const t of fullTargets()) {
      const abs = path.join(baseDirOf(t.base), ...relPath(t.rel));
      let st; try { st = fs.statSync(abs); } catch (_) { missing.push(t.spec); continue; }
      const list = st.isDirectory() ? walkFiles(abs).map((r) => t.rel + '/' + r) : [t.rel];
      for (const rel of list) jobs.push({ t, rel });
    }
    let jn = 0;
    {
      for (const { t, rel } of jobs) {
        jobCheck();
        progSet(K, { done: jn++, total: jobs.length, unit: 'files', text: rel });
        const src = path.join(baseDirOf(t.base), ...relPath(rel)), dst = path.join(part, t.base, ...relPath(rel));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        let sha = '', tries = 0;
        for (;;) {                                  // a file that changes while it is copied (server running) is retried once
          tries++;
          const a = await sha256Async(src); fs.copyFileSync(src, dst); const b = await sha256Async(dst);
          if (a === b) { sha = b; break; }
          if (tries >= 2) throw new Error(rel + ' keeps changing while it is copied - stop the server and try again');
        }
        const size = fs.statSync(dst).size; bytes += size; files.push({ base: t.base, rel, size, sha });
      }
    }
    let db = null, warn = '';
    let dbSrc = opt.dbFile || null;
    jobCheck();
    
    progSet(K, { done: jobs.length, total: jobs.length, unit: 'files', text: 'Files copied and checked' });
    if (dbSrc) {
      progStage(K, 'Adding the database dump', opt.step, opt.steps);
      const dst = path.join(part, 'db', path.basename(dbSrc)); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(dbSrc, dst);
      const chk = await gzipCheck(dst);
      if (!chk.ok) throw new Error('the database dump is not readable (' + chk.error + ')');
      db = { file: path.basename(dbSrc), size: fs.statSync(dst).size, sha: await sha256Async(dst), complete: chk.complete };
      bytes += db.size;
      if (!chk.complete) warn = 'The database dump has no "Dump completed" line at the end - check it before relying on it.';
    }
    const manifest = { format: 1, created: Date.now(), reason: reason || 'manual', serverVersion: installedServerVersion(), serverDir: serverDir(), files, db, missing };
    fs.writeFileSync(path.join(part, 'manifest.json'), JSON.stringify(manifest));
    const summary = { created: manifest.created, reason: manifest.reason, serverVersion: manifest.serverVersion, files: files.length, bytes, db: db ? { file: db.file, complete: db.complete } : null, missing, warn };
    fs.writeFileSync(path.join(part, 'summary.json'), JSON.stringify(summary));
    fs.renameSync(part, final);
    pruneFull(); fullCache = listFull();
    if (own) progEnd(K, true, 'Full backup ' + name + ': ' + files.length + ' files, ' + human(bytes));
    logChange('backup.full', 'Full backup (' + (reason || 'manual') + '): ' + files.length + ' files, ' + human(bytes) + (db ? ', database included' : ', no database') + (missing.length ? '; not present: ' + missing.join(', ') : ''), { ok: true, where: name });
    return { ok: true, name, where: final, files: files.length, bytes, db: !!db, missing, warn, note: 'Full backup ' + name + ': ' + files.length + ' files, ' + human(bytes) + (db ? ' + database' : '') + (warn ? ' (' + warn + ')' : '') };
  } catch (e) {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch (_) { /* gone */ }
    if (e && e.cancelled) {
      if (own) progEnd(K, false, 'Full backup stopped - the half-made copy was deleted');
      logChange('backup.full', 'Full backup STOPPED by ' + e.by + ' - the half-made copy was deleted', { ok: false });
      return { ok: false, cancelled: true, error: e.message + '. The half-made backup was deleted; nothing else was changed.' };
    }
    if (own) progEnd(K, false, 'Full backup failed: ' + e.message);
    logChange('backup.full', 'Full backup FAILED: ' + e.message, { ok: false });
    return { ok: false, error: 'Full backup failed, nothing was changed: ' + e.message };
  }
}
const safeBackupName = (n) => { const s = String(n || '').replace(/[^\w.-]/g, ''); return s && !/^\.+$/.test(s) ? s : ''; };
async function verifyFull(nameRaw, PK, stage) {
  const name = safeBackupName(nameRaw), dir = path.join(fullDir(), name);
  const m = name ? readJson(path.join(dir, 'manifest.json'), null) : null;
  if (!m || !Array.isArray(m.files)) return { ok: false, error: 'That backup has no manifest - it is incomplete.' };
  const bad = [];
  const K = PK || progStart('verify' + name, 'Verifying backup ' + name, { kind: 'verify' });
  if (PK) progStage(K, stage || 'Checking the backup', 1, 3);
  let vn = 0;
  try {
  for (const f of m.files) {
    jobCheck();
    progSet(K, { done: vn++, total: m.files.length, unit: 'files', text: f.rel });
    try { if ((await sha256Async(path.join(dir, f.base, ...relPath(f.rel)))) !== f.sha) bad.push(f.rel + ' (changed)'); } catch (_) { bad.push(f.rel + ' (missing)'); }
  }
  if (m.db && m.db.file) { try { if ((await sha256Async(path.join(dir, 'db', m.db.file))) !== m.db.sha) bad.push('database dump (changed)'); } catch (_) { bad.push('database dump (missing)'); } }
  } finally { if (!PK) progEnd(K, !bad.length, bad.length ? bad.length + ' file(s) do not match' : 'All ' + m.files.length + ' files match'); }
  if (bad.length) { logChange('backup.verify', 'Verify ' + name + ' FAILED: ' + bad.length + ' problem(s), e.g. ' + bad[0], { ok: false }); return { ok: false, error: bad.length + ' file(s) do not match: ' + bad.slice(0, 3).join(', '), bad }; }
  logChange('backup.verify', 'Verified ' + name + ': ' + m.files.length + ' files OK', { ok: true });
  return { ok: true, note: name + ' verified: all ' + m.files.length + ' files' + (m.db ? ' and the database dump' : '') + ' match.' };
}
async function restoreFull(nameRaw, body) {
  if (String(body.confirmText || '') !== 'RESTORE') return { ok: false, error: 'Type RESTORE to confirm.' };
  const name = safeBackupName(nameRaw), dir = path.join(fullDir(), name);
  if ((await findServer()).running) return { ok: false, error: 'Stop the server first.' };
  const K = progStart('restore' + name, 'Restoring backup ' + name, { kind: 'restore', steps: 3 });
  const v = await verifyFull(name, K, 'Checking the backup before touching anything');
  if (!v.ok) { progEnd(K, false, 'Backup does not verify - nothing was changed'); return { ok: false, error: 'This backup does not verify, nothing was changed: ' + v.error }; }
  const m = readJson(path.join(dir, 'manifest.json'));
  updating = true;
  try {
    const pre = await backupFull('safety copy before restoring ' + name, { db: false, tag: 'pre-restore', prog: K, stage: 'Saving what is there now as a safety copy', step: 2, steps: 3 });
    if (!pre.ok) { progEnd(K, false, 'Could not make the safety copy - nothing was changed'); return { ok: false, error: 'Could not make the safety copy first, nothing was changed: ' + pre.error }; }
    let n = 0;
    progStage(K, 'Copying files back', 3, 3);
    try {
      for (const f of m.files) {
        jobCheck();
        progSet(K, { done: n, total: m.files.length, unit: 'files', text: f.rel });
        const src = path.join(dir, f.base, ...relPath(f.rel)), dest = path.join(baseDirOf(f.base), ...relPath(f.rel)), tmp = dest + '.restore-tmp';
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, tmp); if ((await sha256Async(tmp)) !== f.sha) { fs.rmSync(tmp, { force: true }); throw new Error('verify failed for ' + f.rel); }
        fs.renameSync(tmp, dest); n++;
      }
    } catch (e) {
      logChange('backup.restore', 'Restore of ' + name + ' stopped after ' + n + ' files: ' + e.message, { ok: false });
      progEnd(K, false, 'Restore stopped after ' + n + ' of ' + m.files.length + ' files');
      return { ok: false, error: 'Restore stopped after ' + n + ' of ' + m.files.length + ' files: ' + e.message + '. Your files from before are in full backup ' + pre.name + '.' };
    }
    progEnd(K, true, 'Restored ' + n + ' files from ' + name);
    emit('alert', { level: 'ok', text: 'RESTORED ' + n + ' files from backup ' + name + '.' });
    logChange('backup.restore', 'Restored ' + n + ' files from ' + name + ' (safety copy ' + pre.name + ')', { ok: true, where: name });
    return { ok: true, note: 'Restored ' + n + ' files from ' + name + '. What was there before is saved as ' + pre.name + '. Files added after the backup were left alone.' + (m.db ? ' The database was NOT touched; its dump is ' + path.join(dir, 'db', m.db.file) + '.' : '') };
  } finally { updating = false; }
}

// ------------------------------------------------------------------ UPDATE WATCHER: tells the admin when something new is out
// Server: reads the version off a web page (default open2077.net/host). Launcher + other repos: GitHub API (release -> tag -> commit).
// Git clones found next to the server are compared by commit. Results: watch.json next to dashboard.json. Private repos: GITHUB_TOKEN in ChoomVille_Secrets.cmd.
const watchFile = () => path.join(dashDir(), 'watch.json');
let watchMem = null, watching = false;
function watchLoad() { return Object.assign({ lastCheck: 0, items: [], seen: {}, installed: {}, repos: [] }, readJson(watchFile(), {})); }












function watchBrief() { const w = watchMem || (watchMem = watchLoad()); return { count: w.items.filter((i) => i.status === 'update').length, lastCheck: w.lastCheck }; }


// ------------------------------------------------------------------ status snapshot
let snapshot = null;
async function buildSnapshot() {
  if (vpsMod) vpsMod.tick().catch(() => {});     // asks the VPS now and then, never blocks this poll
  const proc = await findServer();
  watchServerPids(proc);
  if (proc.running && transition === 'starting') transition = null;
  if (!proc.running && transition === 'stopping') transition = null;
  if (transition && Date.now() > transitionUntil) transition = null;
  const sp = progs.get('srv');
  if (sp && sp.kind === 'start') {
    if (proc.running) progEnd('srv', true, 'The server process is running (PID ' + proc.pids.join(', ') + '). Watch the Server log for "ready".');
    else if (!transition) progEnd('srv', false, 'No server process appeared within 90 s - read the Server log tab.');
  }
  lastProc = proc;
  const ports = cfg.server.ports || {};
  const probes = await Promise.all([
    ports.download ? tcpUp(ports.download) : false,
    ports.warden ? tcpUp(ports.warden) : false,
    cfg.server.dbPort ? tcpUp(cfg.server.dbPort) : false,
  ]);
  const st = loadState();
  const rl = loadList();
  const lastAt = st.lastBackupAt || 0;
  snapshot = {
    title: PRODUCT.name,
    product: PRODUCT,
    serverFolderOk: (() => { try { return fs.statSync(serverDir()).isDirectory(); } catch (_) { return false; } })(),
    serverName: shortServerName(serverNameNow()),
    perf: perfInfo(),
    serverFull: serverNameNow(),
    user: OSUSER,
    mode: VPS_MODE ? 'vps' : 'local',
    vps: vpsMod ? vpsMod.summary() : null,
    auto: autoSettings(),
    wantRunning,
    lastBackupAt: lastAt,
    backups: backupsCache,
    backupsDir: backupsDir(),
    fullBackups: fullCache,
    watch: watchBrief(),
    platform: process.platform,
    serverDir: serverDir(),
    server: { state: transition || (proc.running ? 'online' : 'offline'), pids: proc.pids, startedAt: proc.startedAt },
    ports: { game: ports.game || null, download: { port: ports.download, up: probes[0] }, warden: { port: ports.warden, up: probes[1] } },
    db: { port: cfg.server.dbPort || null, up: probes[2] },
    resourcesCount: rl.rows ? rl.rows.length : 0,
    links: cfg.links || [],
    buttons: (cfg.buttons || []).map((b) => ({ id: b.id, label: b.label, group: b.group || 'Tools', hint: b.hint || '', danger: !!b.danger, confirm: b.confirm || '', typeToConfirm: b.typeToConfirm || '' })),
    progress: (cfg.progress || []).map((p) => ({ id: p.id, title: p.title, note: p.note || '', group: p.group || '', step: p.step || 0, parent: p.parent || '', evidence: p.evidence || '', left: Array.isArray(p.left) ? p.left.map(String) : [], updated: (st.progressAt || {})[p.id] || p.updated || '', status: (st.progress || {})[p.id] || p.status || 'todo' })),
  };
  emit('state', snapshot);
  return snapshot;
}

// ---- monitor: real measurements only (OS numbers for the server process + Open77's own /metrics endpoint when it is on) ----
function jsoncStrip(text) {
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (str) { out += c; if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
function jsoncParse(text) {
  const s = jsoncStrip(text); let out = '', str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { out += c; if (c === '\\') { out += s[++i] || ''; } else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++; if (s[j] === '}' || s[j] === ']') continue; }
    out += c;
  }
  return JSON.parse(out);
}




const mon = { ring: [], timer: null, lastPoll: 0, busy: false, prevProc: null, prevSys: null, prevCnt: new Map(), res: [], rhist: new Map(), resFam: {}, metrics: { state: 'off', note: '' }, sentPrev: null };










// ------------------------------------------------------------------ VPS (vps.js, optional)
// VNR_MODE=vps (VNR_VPS_Launcher.bat) opens the VPS page and leaves the local automation/update watch to the other launcher
// window, so two launchers never both restart or check the same things.
const VPS_MODE = process.env.VNR_MODE === 'vps';
let vpsMod = null;


// ------------------------------------------------------------------ http
const TOKEN = crypto.randomBytes(24).toString('hex');
function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
}
function cookieOk(req) {
  const c = String(req.headers.cookie || '');
  const m = c.match(/(?:^|;\s*)cvdash=([a-f0-9]+)/);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function send(res, code, body, type) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 65536) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const busy = new Set();
async function once(key, fn) {
  if (busy.has(key)) return { ok: false, error: 'Already working on that - wait a moment.' };
  busy.add(key);
  try { return await fn(); }
  catch (e) { if (e && e.cancelled) return { ok: false, cancelled: true, error: e.message }; throw e; }
  finally { busy.delete(key); }
}

// WHO is asking: the dashboard page sends X-CV-Via: ui and the operator name; anything else is a script / API client
function actorFromReq(req) {
  const h = req.headers, ua = String(h['user-agent'] || '').slice(0, 140), ip = (req.socket && req.socket.remoteAddress) || '';
  if (String(h['x-cv-via'] || '') === 'ui') {
    let who = ''; try { who = decodeURIComponent(String(h['x-cv-who'] || '')); } catch (_) { who = ''; }
    who = who.replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 40);
    return { type: 'person', name: who || OSUSER, via: 'dashboard (browser)', ua, ip };
  }
  let sn = ''; try { sn = decodeURIComponent(String(h['x-cv-script'] || '')); } catch (_) { sn = ''; }
  sn = sn.replace(/[^\w .:@-]/g, '').trim().slice(0, 40);
  return { type: 'script', name: sn || (/^(curl|python|node|undici|axios|powershell|wget)/i.test(ua) ? ua.split(/[ /]/)[0].toLowerCase() : 'api client'), via: 'HTTP API (no dashboard header)', ua, ip };
}
const QUIET_POSTS = new Set(['/api/vps/logs', '/api/vps/info', '/api/vps/refresh', '/api/vps/auto.status', '/api/vps/git.status']);
const API_LABELS = {
  '/api/server/start': 'Start server', '/api/server/stop': 'Stop server', '/api/server/restart': 'Restart server',
  '/api/backup': 'Backup', '/api/backup/full': 'Full backup', '/api/backup/verify': 'Verify backup', '/api/backup/restore': 'Restore backup',
  '/api/watch/check': 'Check for updates', '/api/watch/add': 'Watch a repository', '/api/watch/remove': 'Stop watching a repository', '/api/watch/installed': 'Mark as installed', '/api/watch/set': 'Change update-check settings',
  '/api/auto': 'Change automation setting', '/api/resources/add': 'Add resource to load list', '/api/resources/remove': 'Remove resource from load list', '/api/resources/move': 'Move resource in load order',
  '/api/update/plan': 'Check update zip', '/api/update/apply': 'Apply update', '/api/update/download': 'Download update', '/api/update/downloadall': 'Download all updates', '/api/update/source': 'Set update source', '/api/update/auto': 'Update everything now',
  '/api/update/openlog': 'Open update log', '/api/update/rollback': 'Roll back update', '/api/update/report': 'Read update report', '/api/progress': 'Set rebuild-progress status', '/api/reload': 'Reload dashboard.json',
  '/api/monitor/enable': 'Enable monitor', '/api/patches/snapshot': 'Save patched files', '/api/patches/apply': 'Re-apply patched files', '/api/patches/forget': 'Stop tracking a patched file',
  '/api/job/cancel': 'Stop a running job', '/api/job/cancelall': 'Stop all running jobs', '/api/emergency': 'EMERGENCY STOP', '/api/server/name': 'Rename the server', '/api/settings/set': 'Change panel settings', '/api/serverinfo/set': 'Change server details', '/api/mods/set': 'Change the required-mods rules', '/api/perf': 'Change the launcher speed mode', '/api/crashes/save': 'Save a copy of the server log', '/api/crashes/open': 'Open the saved server logs folder', '/api/mods/add': 'Require a mod', '/api/mods/remove': 'Stop requiring a mod', '/api/launcher/repo': 'Connect launcher repository', '/api/launcher/install': 'Update the launcher from GitHub', '/api/launcher/publish': 'Publish the launcher to GitHub', '/api/launcher/rollback': 'Roll back the launcher', '/api/launcher/restart': 'Restart the launcher', '/api/launcher/zip': 'Update the launcher from a zip', '/api/launcher/openzips': 'Open the launcher zip folder',
};
function apiLabel(p, body) {
  if (p === '/api/action') { const b = buttonById(String(body.id || '')); return b ? 'Button: ' + b.label : 'Button (unknown)'; }
  if (p.startsWith('/api/vps/')) return 'VPS: ' + p.slice(9);
  return API_LABELS[p] || p.replace(/^\/api\//, '');
}
function apiDetail(p, body) {
  const b = body || {};
  if (p === '/api/action') { const x = buttonById(String(b.id || '')); return x ? (x.group ? x.group + ' / ' : '') + x.label + ' [' + x.id + ']' + (x.cmd ? ' -> ' + x.cmd.join(' ') : x.run ? ' -> ' + x.run : '') : String(b.id || ''); }
  if (p === '/api/job/cancel') { const pr = progs.get(String(b.key || '')); return pr ? '"' + pr.label + '" (started by ' + pr.actor + ')' : String(b.key || ''); }
  if (p === '/api/job/cancelall') return jobList().length + ' job(s) running: ' + jobList().map((j) => j.label).join('; ');
  if (p === '/api/auto') return String(b.group) + '.' + String(b.field) + ' = ' + String(b.value);
  if (p === '/api/progress') return String(b.id) + ' = ' + String(b.status);
  if (/^\/api\/(backup\/(verify|restore))$/.test(p)) return String(b.name || '');
  if (/^\/api\/update\//.test(p)) return [b.pack && 'pack ' + b.pack, b.zip && 'zip ' + b.zip, b.planId && 'plan ' + b.planId, b.id && 'id ' + b.id].filter(Boolean).join(', ');
  if (/^\/api\/resources\//.test(p)) return String(b.name || b.rel || b.id || '');
  const rb = redactBody(b); const j = JSON.stringify(rb); return j === '{}' ? '' : j;
}
// ------------------------------------------------------------------ LAUNCHER SELF-UPDATE (GitHub)
// The launcher's own files (server.js + vps.js) can live in a GitHub repo. "Check" compares them by git blob hash, "Install"
// downloads the repo's versions, syntax-checks BOTH before touching anything, keeps a backup, swaps them in, and a restart
// loads them. "Publish" pushes this PC's version to the repo (one commit). Token: GITHUB_TOKEN in ChoomVille_Secrets.cmd.
const SELF_FILES = ['server.js', 'vps.js'];















// every file the launcher updates: server.js, vps.js and the VPS helper scripts (dashboard.json and your settings are never touched)


// check every new file, back up the current ones, swap them in (all or nothing). files: { 'server.js': Buffer, 'vps/vps_ctl.ps1': Buffer, ... }


// MANUAL update: a zip downloaded from the repository (Code > Download ZIP) dropped into launcher_updates/




const SELF_README = '# VNR Server Launcher\n\nThe launcher for the ChoomVille server. `server.js` + `vps.js` are the whole program (Node 18+, no packages).\n\nThe launcher can update itself from this repository (Updates page > Launcher). Publishing from the launcher pushes the two files here as one commit.\n';
const SELF_IGNORE = '# runtime + private files that never belong in the repository\ndashboard.json\nstate.json\nwatch.json\nlauncher_repo.json\nlauncher_backups/\nlogs/\nbackups/\nupdstate/\nvps/\nvps_pack/\nwork/\n*.cmd\n*.incoming.js\n*.tmp-*\nupdate_log.md\n';


// restart the launcher itself: a helper waits for this process to let go of the port, then starts a fresh copy (which opens the page again)


// ------------------------------------------------------------------ server name + required mods (server.jsonc)
// Both edit ONE value inside server.jsonc: text outside the changed value is never touched, comments survive, a backup is kept first.
function jsonKeySpan(text, key) {
  // finds "key": <value> directly inside the root { } and returns { vs, ve } = start/end of the value
  let i = 0, depth = 0, str = false;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (str) { if (c === '\\') { i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') { depth--; i++; continue; }
    if (c === '"') {
      if (depth === 1) {
        let j = i + 1; while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
        const name = text.slice(i + 1, j);
        let k = j + 1; while (k < text.length && /\s/.test(text[k])) k++;
        if (name === key && text[k] === ':') {
          k++; while (k < text.length && /\s/.test(text[k])) k++;
          const vs = k; let ve = k;
          if (text[k] === '{' || text[k] === '[') {
            let dd = 0, s2 = false;
            for (; ve < text.length; ve++) {
              const ch = text[ve];
              if (s2) { if (ch === '\\') ve++; else if (ch === '"') s2 = false; continue; }
              if (ch === '"') s2 = true; else if (ch === '{' || ch === '[') dd++; else if (ch === '}' || ch === ']') { dd--; if (dd === 0) { ve++; break; } }
            }
          } else if (text[k] === '"') {
            ve = k + 1; while (ve < text.length && text[ve] !== '"') { if (text[ve] === '\\') ve++; ve++; } ve++;
          } else { while (ve < text.length && !/[,}\]\n]/.test(text[ve])) ve++; }
          return { vs, ve };
        }
        i = j + 1; continue;
      }
      str = true; i++; continue;
    }
    i++;
  }
  return null;
}
function readServerCfg() {
  let text; try { text = fs.readFileSync(serverJsonc(), 'utf8'); } catch (e) { return { error: 'cannot read server.jsonc' }; }
  let obj; try { obj = jsoncParse(text); } catch (e) { return { error: 'server.jsonc does not parse: ' + String(e.message).split('\n')[0] }; }
  return { text, obj };
}
let nameCache = { mt: 0, name: '' };
function serverNameNow() {
  try {
    const st = fs.statSync(serverJsonc());
    if (st.mtimeMs !== nameCache.mt) {
      const o = jsoncParse(fs.readFileSync(serverJsonc(), 'utf8'));
      nameCache = { mt: st.mtimeMs, name: String((o.identity && o.identity.name) || '') };
    }
    return nameCache.name;
  } catch (_) { return nameCache.name; }
}
function shortServerName(n) { return String(n || '').replace(/\s*[-|–—]\s*https?:\/\/\S+.*$/i, '').replace(/\s*https?:\/\/\S+.*$/i, '').trim(); }
function renameServer(body) {
  const name = String(body.name == null ? '' : body.name).replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'The server name cannot be empty.' };
  if (name.length > 96) return { ok: false, error: 'The server name is too long (96 characters at most).' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'The server name has control characters in it.' };
  const r = readServerCfg(); if (r.error) return { ok: false, error: r.error + ' - nothing written' };
  const idn = jsonKeySpan(r.text, 'identity');
  if (!idn || r.text[idn.vs] !== '{') return { ok: false, error: 'There is no "identity" section in server.jsonc - nothing written' };
  const inner = r.text.slice(idn.vs, idn.ve);
  const nm = jsonKeySpan(inner, 'name');
  if (!nm) return { ok: false, error: 'There is no "name" inside "identity" in server.jsonc - nothing written' };
  const was = String((r.obj.identity && r.obj.identity.name) || '');
  if (was === name) return { ok: true, note: 'That is already the server name.', name };
  const next = r.text.slice(0, idn.vs + nm.vs) + JSON.stringify(name) + r.text.slice(idn.vs + nm.ve);
  let chk; try { chk = jsoncParse(next); } catch (_) { return { ok: false, error: 'the edit would break server.jsonc - nothing written' }; }
  const strip = (o, k) => { const c = Object.assign({}, o); delete c[k]; return JSON.stringify(c); };
  const same = strip(chk, 'identity') === strip(r.obj, 'identity');
  if (!chk.identity || chk.identity.name !== name || !same) return { ok: false, error: 'the edit did not come out as intended - nothing written' };
  const backup = backupConfigFiles('before renaming the server');
  atomicWrite(serverJsonc(), next); watchTick(true); nameCache.mt = 0;
  pushLog('server.jsonc: server name -> ' + name + ' (backup ' + path.basename(backup.where) + ')', 'dash');
  logChange('server.rename', 'Server name: "' + was + '" -> "' + name + '"', { ok: true, where: path.basename(backup.where) });
  return { ok: true, name, backup: path.basename(backup.where), note: 'Server name saved. Restart the server so players see the new name in the server list.' };
}










// ------------------------------------------------------------------ crash log reader
// Reads the server log (logs/server-latest.log is rewritten at every start), splits it into runs, groups the errors and
// says how each run ended. A copy of every run's log is kept in <launcher>/logs/server-history before it is lost.
const histDir = () => path.join(dashDir(), 'logs', 'server-history');

let lastArch = '';
function archiveServerLog(reason) {
  try {
    const f = logFile(); const st = fs.statSync(f); if (!st.isFile() || st.size < 200) return null;
    const key = st.size + ':' + Math.round(st.mtimeMs);
    if (key === lastArch) return null;
    fs.mkdirSync(histDir(), { recursive: true });
    const have = fs.readdirSync(histDir()).sort();
    const tag = '_' + st.size + 'b';
    if (have.length && have[have.length - 1].includes(tag)) { lastArch = key; return null; }
    const name = stampNow() + '_' + String(reason || 'manual').replace(/[^a-z0-9-]/gi, '') + tag + '.log';
    fs.copyFileSync(f, path.join(histDir(), name)); lastArch = key;
    const keep = (cfg.crashes && cfg.crashes.keep) || 30;
    const all = fs.readdirSync(histDir()).sort();
    for (const n of all.slice(0, Math.max(0, all.length - keep))) { try { fs.rmSync(path.join(histDir(), n), { force: true }); } catch (_) { /* in use */ } }
    return name;
  } catch (_) { return null; }
}
const CRASH_HINTS = [
  [/Address already in use|only one usage of each socket|bind.*(fail|error)|port .* (in use|busy)/i, 'A port is already taken - another server window or program is using the game, download or warden port. Stop the other copy first.'],
  [/out of memory|OutOfMemory|bad_alloc|cannot allocate/i, 'The server ran out of memory. Close other programs or lower the load.'],
  [/(access|permission) denied|UnauthorizedAccess|being used by another process/i, 'A file was locked or not allowed. Check antivirus, read-only files and a second server copy.'],
  [/database|mysql|mariadb|sql(state)?\b.*(refused|fail|timeout|denied|unknown)|connection refused/i, 'The database did not answer or refused the login. Start MariaDB first and check the connection string.'],
  [/attempt to (index|call|perform|concatenate|compare)|bad argument|stack traceback|\.lua:\d+/i, 'A Lua script threw an error. The resource name and file:line are in the message below.'],
  [/required ?mods?|digest|unsecured|attestation|hash mismatch/i, 'Something about the required-mods list. Check the Mods page (hosted executable mods need Unsecured on).'],
  [/manifest|dependency|missing resource|could not load resource|failed to start resource/i, 'A resource could not start - a missing dependency, a wrong path or a broken open77.lua.'],
  [/jsonc?\b.*(parse|invalid|unexpected)|unexpected (token|character)|schema/i, 'server.jsonc has a mistake the server could not read. Restore the last backup from the Backups page.'],
  [/unhandled exception|fatal|segmentation|access violation|0xC0000005/i, 'The server process itself crashed. The lines before the end of the run show what it was doing.'],
  [/license|licence|master ?server|ticket|token/i, 'A problem talking to the master server or with the licence key.'],
];
const LOG_RE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d\d:\d\d) \[(\w+)\] ?(.*)$/;





// ------------------------------------------------------------------ who started the server? (catches starts the launcher did not do)
let lastLauncherStart = 0, prevPids = null;
async function describeProc(pid) {
  if (!IS_WIN) return '';
  const ps = "$id=" + (+pid) + "; $o=@(); for($i=0;$i -lt 7 -and $id;$i++){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue; if(-not $p){break}; $c=[string]$p.CommandLine; if($c.Length -gt 170){$c=$c.Substring(0,170)}; $o+=\"$($p.Name) [$($p.ProcessId)] $c\"; $id=$p.ParentProcessId }; $o -join ' <- '";
  const r = await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
  return r.stdout.trim().replace(/\s+/g, ' ');
}
function watchServerPids(proc) {
  const now = new Set(proc.pids || []);
  if (prevPids === null) { prevPids = now; return; }
  const fresh = [...now].filter((p) => !prevPids.has(p)), gone = [...prevPids].filter((p) => !now.has(p));
  prevPids = now;
  if (!fresh.length) return;
  const mine = Date.now() - lastLauncherStart < 180000;
  if (mine) return;
  const replaced = gone.length ? ' It replaced PID ' + gone.join(', ') + ' (the server start script stops an older copy when it starts).' : '';
  describeProc(fresh[0]).then((who) => {
    logChange('server.external', 'The server was started by something other than this launcher (PID ' + fresh[0] + ').' + replaced + (who ? ' Started by: ' + who : ''), { ok: false });
    emit('alert', { level: 'warn', text: 'The server was (re)started outside the launcher - see the Command log for what started it.' });
  }).catch(() => {});
}
// ------------------------------------------------------------------ light mode for slow CPUs (VPS)
// Auto = light when the machine has 4 or fewer cores or the launcher itself is lagging. Light polls less often, caches file scans and never lets two polls pile up.
const perfFile = () => path.join(dashDir(), 'launcher_perf.json');
let perfPrefV = null, loopLag = 0, lagLightUntil = 0;
function perfPref() { if (perfPrefV === null) { const j = readJson(perfFile(), {}); perfPrefV = ['auto', 'normal', 'light'].includes(j.mode) ? j.mode : (['auto', 'normal', 'light'].includes(cfg.performance) ? cfg.performance : 'auto'); } return perfPrefV; }
function perfLight() {
  const p = perfPref(); if (p === 'light') return true; if (p === 'normal') return false;
  if (loopLag > 120) lagLightUntil = Date.now() + 600000;
  return os.cpus().length <= 4 || Date.now() < lagLightUntil;
}
(function () { let t = Date.now(); setInterval(() => { const d = Date.now() - t - 1000; t = Date.now(); loopLag = loopLag * 0.7 + Math.max(0, d) * 0.3; }, 1000); })();
function perfInfo() { return { pref: perfPref(), light: perfLight(), lagMs: Math.round(loopLag), cpus: os.cpus().length }; }
function perfSet(body) {
  const m = String(body.mode || ''); if (!['auto', 'normal', 'light'].includes(m)) return { ok: false, error: 'mode must be auto, normal or light' };
  perfPrefV = m; atomicWrite(perfFile(), JSON.stringify({ mode: m }, null, 1));
  logChange('launcher.perf', 'Launcher speed set to ' + m + (perfLight() ? ' (light is active)' : ' (normal is active)'), { ok: true });
  return { ok: true, note: 'Launcher speed: ' + m + (perfLight() ? ' - light mode is on.' : ' - normal mode is on.'), perf: perfInfo() };
}
function loop(fn, normalMs, lightMs) {
  const run = async () => { try { await fn(); } catch (_) { /* keep going */ } setTimeout(run, perfLight() ? lightMs : normalMs); };
  setTimeout(run, normalMs);
}
let llc = { t: 0, sig: '', val: null };
function loadList() {
  let sig = ''; try { const st = fs.statSync(serverJsonc()); sig = st.size + ':' + Math.round(st.mtimeMs); } catch (_) { /* unreadable */ }
  const ttl = perfLight() ? 45000 : 12000;
  if (llc.val && llc.sig === sig && Date.now() - llc.t < ttl) return llc.val;
  const v = loadListRaw(); llc = { t: Date.now(), sig, val: v }; return v;
}
const dirSizeMemo = new Map();
function dirSizeCached(f, cap, mt) { const k = f + ':' + Math.round(mt || 0); if (dirSizeMemo.has(k)) return dirSizeMemo.get(k); const v = dirSize(f, cap); dirSizeMemo.set(k, v); if (dirSizeMemo.size > 200) dirSizeMemo.delete(dirSizeMemo.keys().next().value); return v; }
const yieldLoop = () => new Promise((r) => setImmediate(r));
async function treeSigAsync(root, cap) {
  let n = 0, newest = 0, newestFile = '', size = 0;
  const fsp = fs.promises;
  async function w(d) {
    let es; try { es = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) {
      if (n >= cap) return;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') await w(path.join(d, e.name)); continue; }
      let st; try { st = await fsp.stat(path.join(d, e.name)); } catch (_) { continue; }
      n++; size += st.size; if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(root, path.join(d, e.name)).split(path.sep).join('/'); }
      if (n % 250 === 0) await yieldLoop();
    }
  }
  await w(root);
  return { n, newest, newestFile, size };
}
let watchBusy = false;
async function watchTickAsync() {
  if (watchBusy) return; watchBusy = true; const gen = watchGen;
  try {
    const next = {};
    for (const f of (cfg.watchFiles || ['server.jsonc', 'acl.jsonc', 'ChoomVille_Secrets.cmd', 'ChoomVille_Start.bat', 'ChoomVille_Start_Logged.bat', 'Clean_Database.bat'])) {
      try { const st = fs.statSync(path.join(serverDir(), f)); next['file:' + f] = { sig: st.size + ':' + Math.round(st.mtimeMs), label: f }; } catch (_) { next['file:' + f] = { sig: 'missing', label: f }; }
    }
    let text = ''; try { text = fs.readFileSync(serverJsonc(), 'utf8'); } catch (_) { /* unreadable */ }
    const p = text ? parseLoad(text) : null;
    if (p) for (const i of p.items) if (i.kind === 'entry') {
      const t = await treeSigAsync(path.join(resourcesDir(), i.path), 40000);
      next['res:' + i.path] = { sig: t.n + ':' + t.size + ':' + Math.round(t.newest), label: i.path, newest: t.newestFile, n: t.n };
    }
    if (gen === watchGen) watchApply(next, false);
  } finally { watchBusy = false; }
}
// ------------------------------------------------------------------ backup check for updates (check, tell the user, never force)
function ageText(ms) { const h = ms / 3600000; if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min ago'; if (h < 48) return (Math.round(h * 10) / 10) + ' h ago'; return Math.round(h / 24) + ' days ago'; }
function whenText(t) { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function backupCoverage() {
  const hrs = Number((cfg.update && cfg.update.backupFreshHours) || 24), win = hrs * 3600000, now = Date.now();
  const full = listFull().filter((f) => !f.broken && f.created).sort((a, b) => b.created - a.created)[0] || null;
  const all = listBackups();
  const newest = (type) => { const x = all.filter((b) => b.type === type).sort((a, b) => b.t - a.t)[0]; return x ? x.t : 0; };
  const dbT = Math.max(newest('db'), full && full.db ? full.created : 0);
  const fresh = !!(full && now - full.created < win);
  const parts = [];
  if (full) parts.push('Last full backup of the server files: ' + whenText(full.created) + ' (' + ageText(now - full.created) + ')' + (fresh ? '.' : ', older than ' + hrs + ' h.'));
  else parts.push('No full backup of the server files was found.');
  parts.push(dbT ? 'Newest database dump: ' + whenText(dbT) + ' (' + ageText(now - dbT) + ').' : 'No database dump was found.');
  return { fresh, hours: hrs, full: full ? { t: full.created, ageMs: now - full.created, reason: full.reason || '' } : null, dbT, configT: newest('config'), scriptsT: newest('scripts'), text: (fresh ? 'Backup found - no new backup is made. ' : 'No recent backup. ') + parts.join(' ') };
}
const server = http.createServer((req, res) => { als.run({ actor: actorFromReq(req), jobKeys: [], quiet: false }, () => handle(req, res)); });
async function handle(req, res) {
  try {
    if (!hostOk(req)) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://127.0.0.1');
    // first visit: ?t=TOKEN sets the cookie, then we land on /
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('t') === TOKEN) {
      res.writeHead(302, { 'Set-Cookie': 'cvdash=' + TOKEN + '; HttpOnly; SameSite=Strict; Path=/', Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!cookieOk(req)) return send(res, 401, '<!doctype html><meta charset="utf-8"><body style="background:#07080f;color:#9fe;font:16px sans-serif;padding:40px">Open the dashboard from the window that started it (CV_Dashboard.bat). This page needs its one-time link.</body>', 'text/html; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/') cmdNote('session', 'Dashboard opened', actorNow().ua || '', { ok: true });
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE.replace('__VNR_MODE__', VPS_MODE ? 'vps' : 'local'), 'text/html; charset=utf-8');

    if (LITE && url.pathname.indexOf('/api/') === 0 && (url.pathname === '/api/backup' || LITE_PRO.some((p) => url.pathname.indexOf(p) === 0))) return send(res, 200, { ok: false, pro: true, error: 'This is part of the full VNR - CyberPunk Server Panel (40 euro). Email virtualnexusroads@gmail.com to get it.' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot || (await buildSnapshot()));
    
    if (req.method === 'GET' && url.pathname === '/api/updates') return send(res, 200, updOverview());
    
    
    
    if (req.method === 'GET' && url.pathname === '/api/changes') return send(res, 200, changes.slice(-500));
    
    if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, jobList());
    
    
    
    
    
    

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      res.write('event: backfill\ndata: ' + JSON.stringify(logLines.slice(-500)) + '\n\n');
      if (snapshot) res.write('event: state\ndata: ' + JSON.stringify(snapshot) + '\n\n');
      for (const p of progs.values()) res.write('event: progress\ndata: ' + JSON.stringify({ ev: 'start', p }) + '\n\n');
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { /* closed */ } }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (req.method === 'POST') {
      if (req.headers['x-cv'] !== '1') return send(res, 403, { ok: false, error: 'missing header' });
      const body = await readBody(req);
      let r;
      const S = als.getStore(), quiet = QUIET_POSTS.has(url.pathname);
      S.quiet = quiet;
      const ce = quiet ? null : cmdBegin('request', apiLabel(url.pathname, body), { detail: apiDetail(url.pathname, body), body });
      if (ce) S.cmdId = ce.id;
      const done = (code, out) => { if (ce) cmdEnd(ce, !(out && out.ok === false), { result: out && (out.error || out.note), stopped: !!(out && out.cancelled) }); return send(res, code, out); };
      
      switch (url.pathname) {
        case '/api/server/start': r = await once('server', serverStart); break;
        case '/api/server/stop': r = await once('server', serverStop); break;
        case '/api/server/restart': r = await once('server', serverRestart); break;
        case '/api/action': {
          const b = buttonById(String(body.id || ''));
          if (!b) { r = { ok: false, error: 'unknown button' }; break; }
          if (b.typeToConfirm && String(body.confirmText || '') !== b.typeToConfirm) { r = { ok: false, error: 'confirmation text did not match' }; break; }
          r = await once('btn:' + b.id, () => runButton(b));
          if (b.type !== 'builtin' || !/^server\./.test(b.run || '')) logChange('action', 'Button: ' + b.label + (r && r.ok === false ? ' - FAILED: ' + r.error : ''), { ok: !(r && r.ok === false) });
          break;
        }
        
        case '/api/backup/full': r = await once('backup', () => backupFull('manual', { requireDb: false })); backupsCache = listBackups(); fullCache = listFull(); break;
        
        case '/api/backup/restore': r = await once('server', () => once('backup', () => restoreFull(body.name, body))); backupsCache = listBackups(); fullCache = listFull(); break;
        
        
        
        
        
        
        
        
        
        case '/api/update/plan': { const PK = progStart('plan', 'Checking the update zip', { kind: 'plan' }); r = await once('upd', () => makePlan(String(body.pack || ''), body.zip ? String(body.zip) : '', PK)); progEnd(PK, r.ok && !r.problems.length, r.ok ? (r.problems.length ? r.problems.length + ' problem(s) - see the check window' : r.counts.add + ' to add, ' + r.counts.overwrite + ' to replace, ' + r.counts.conflict + ' conflicts') : r.error); } if (r.ok) logChange('update.check', 'Checked ' + r.label + ' zip ' + r.zip + ': ' + r.counts.add + ' add, ' + r.counts.overwrite + ' replace, ' + r.counts.conflict + ' conflicts' + (r.problems.length ? ', PROBLEMS: ' + r.problems.length : ''), { ok: !r.problems.length }); break;
        case '/api/update/apply': r = await once('upd', () => applyPlan(String(body.planId || ''), body)); break;
        
        
        
        
        case '/api/update/report': {
          const jj = readJson(path.join(updBackups(), String(body.id || '').replace(/[^\w.-]/g, ''), 'journal.json'), null);
          if (!jj) { r = { ok: false, error: 'No record of that update.' }; break; }
          const rp = buildReport(jj);
          r = { ok: true, id: jj.id, label: jj.label, from: jj.from, to: jj.to, at: jj.at, status: jj.status, counts: jj.counts, report: rp, text: reportText(jj, rp) };
          break;
        }
        
        
        
        
        case '/api/update/openlog': { if (!fs.existsSync(updLogFile())) writeUpdateLog({ pack: 'log', status: 'CREATED', result: 'no updates yet' }); openTarget(updLogFile()); r = { ok: true, note: updLogFile() }; break; }
        
        case '/api/progress': r = setProgress(String(body.id || ''), String(body.status || '')); break;
        case '/api/reload': reloadConfig(); r = { ok: true }; break;
        case '/api/job/cancel': r = cancelJob(String(body.key || ''), actorNow()); break;
        
        
        case '/api/server/name': r = renameServer(body); break;
        case '/api/settings/get': r = settingsGet(); break;
        case '/api/settings/set': r = settingsSet(body); break;
        case '/api/serverinfo/get': r = serverInfoGet(); break;
        case '/api/serverinfo/set': r = serverInfoSet(body); break;
        
        case '/api/perf': r = perfSet(body); break;
        
        
        
        
        
        
        
        
        
        
        
        default: return done(404, { ok: false, error: 'not found' });
      }
      await buildSnapshot().catch(() => {});      // the page sees the new state with the answer
      return done(200, r);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    const S = als.getStore(), ce = S && S.cmdId ? cmdById.get(S.cmdId) : null;
    if (ce) cmdEnd(ce, false, { result: String(e && e.message || e), stopped: !!(e && e.cancelled) });
    send(res, e && e.cancelled ? 200 : 500, { ok: false, cancelled: !!(e && e.cancelled), error: String(e && e.message || e) });
  }
}

function listen(port, tries) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    console.error('Cannot start the dashboard: ' + e.message); process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/?t=' + TOKEN;
    console.log('');
    console.log('  Lite edition. Full version: ' + '40 euro - email virtualnexusroads@gmail.com');
  console.log('  ' + PRODUCT.name + ' is running.   (' + PRODUCT.brand + '  -  ' + PRODUCT.siteShort + ')');
    try { fs.mkdirSync(updDirs()[0], { recursive: true }); } catch (_) { /* shown on the Updates page */ }
    console.log('  Server folder : ' + serverDir());
    if (VPS_MODE) console.log('  Mode          : VPS (opens on the VPS page; local auto-restart is left to the other launcher window)');
    console.log('  Dashboard     : ' + url);
    console.log('  Keep this window open. Close it (or Ctrl+C) to shut the dashboard down. The game server keeps running.');
    console.log('');
    if (process.env.CV_DASH_PRINT_URL) fs.writeFileSync(process.env.CV_DASH_PRINT_URL, url);
    try { fs.writeFileSync(instFile(), JSON.stringify({ pid: process.pid, port: port, url: url })); } catch (_) {}
    process.on('exit', () => { try { const c = JSON.parse(fs.readFileSync(instFile(), 'utf8')); if (c.pid === process.pid) fs.unlinkSync(instFile()); } catch (_) {} });
    if (!NO_OPEN) openTarget(url);
  });
}
// one launcher per mode (local / vps): a second copy opens the page of the one already running and quits,
// instead of climbing to the next port and opening a second tab
const instFile = () => path.join(ROOT, 'launcher_instance_' + (VPS_MODE ? 'vps' : 'local') + '.json');
function instanceGuard(next) {
  let lk = null;
  try { lk = JSON.parse(fs.readFileSync(instFile(), 'utf8')); } catch (_) {}
  if (!lk || !lk.pid || lk.pid === process.pid) return next();
  let alive = false;
  try { process.kill(lk.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive) return next();
  const rq = http.get({ host: '127.0.0.1', port: lk.port, path: '/', timeout: 1500 }, (r) => {
    r.resume();
    console.log('');
    console.log('  The ' + (VPS_MODE ? 'VPS' : 'server') + ' launcher is already running (PID ' + lk.pid + ', port ' + lk.port + ').');
    console.log('  Opening its page instead of starting a second copy.');
    console.log('  ' + lk.url);
    console.log('');
    if (!NO_OPEN) openTarget(lk.url);
    setTimeout(() => process.exit(0), 400);
  });
  rq.on('timeout', () => rq.destroy());
  rq.on('error', () => next());
}

loadChanges();
loadCommands();
cmdNote('session', 'Launcher started', PRODUCT.name + ' on ' + process.platform + ', pid ' + process.pid + ', run as ' + OSUSER, { ok: true });
logChange('launcher.start', PRODUCT.name + ' started (' + process.platform + ', server folder ' + serverDir() + ')', { ok: true });
backupsCache = listBackups();
fullCache = listFull();
if (!VPS_MODE) { watchTick(true); }
loop(() => tailTick(), 400, 1000);
loop(() => buildSnapshot(), cfg.pollSeconds ? cfg.pollSeconds * 1000 : 3000, Math.max(6000, (cfg.pollSeconds || 3) * 2000));
loop(() => { if (!VPS_MODE) return watchTickAsync(); }, (cfg.watchSeconds || 30) * 1000, Math.max(120000, (cfg.watchSeconds || 30) * 4000));
loop(() => { backupsCache = listBackups(); fullCache = listFull(); }, 20000, 90000);
process.on('SIGINT', () => { cmdNote('session', 'Launcher closed', 'Ctrl+C in the launcher window', { ok: true }); logChange('launcher.stop', PRODUCT.name + ' closed', { ok: true }); process.exit(0); });
buildSnapshot().then(() => tailTick()).catch(() => {});
instanceGuard(() => listen(+(process.env.CV_DASH_PORT || cfg.port || 7077), 10));

// ------------------------------------------------------------------ the page
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VNR - CyberPunk Server Panel Lite</title>
<link rel="icon" href="data:image/png;base64,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">
<style>
:root{--bg:#05060c;--panel:#0b0d18;--panel2:#10132a;--line:#1c2142;--txt:#e6ebff;--dim:#8089ad;--cy:#2fa8ff;--mg:#c23bff;--ok:#2be0a0;--warn:#ffc83d;--bad:#ff4d6d;--r:8px;--grad:linear-gradient(90deg,#2fa8ff,#7b5cff 50%,#e03bff);--glow:rgba(47,168,255,.14)}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#eef1f8;--panel:#fff;--panel2:#f4f6fc;--line:#cdd5ea;--txt:#12182c;--dim:#5b6685;--cy:#0a6fd0;--mg:#8a1fd0;--ok:#07885a;--warn:#946f00;--bad:#c4002f;--glow:rgba(10,111,208,.08)}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--txt);font:14px/1.45 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;
 background-image:radial-gradient(900px 400px at 0% -10%,rgba(0,220,255,.08),transparent),radial-gradient(900px 400px at 100% -10%,rgba(255,43,208,.07),transparent)}
header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
h1{margin:0;font:700 17px/1 "Segoe UI",sans-serif;letter-spacing:.18em;text-transform:uppercase}
h1 b{color:var(--cy)} h1 i{color:var(--mg);font-style:normal}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border:1px solid var(--line);border-radius:99px;font-weight:600;letter-spacing:.08em;font-size:12px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
.pill.online{color:var(--ok);border-color:var(--ok)}.pill.online .dot{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.pill.offline{color:var(--bad);border-color:var(--bad)}.pill.offline .dot{background:var(--bad)}
.pill.starting,.pill.stopping{color:var(--warn);border-color:var(--warn)}.pill.starting .dot,.pill.stopping .dot{background:var(--warn);animation:p 1s infinite}
@keyframes p{50%{opacity:.25}}
.sp{flex:1}
button{font:inherit;color:var(--txt);background:var(--panel2);border:1px solid var(--line);border-radius:var(--r);padding:7px 14px;cursor:pointer;transition:.12s}
button:hover:not(:disabled){border-color:var(--cy);color:var(--cy)}button:disabled{opacity:.4;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--cy);outline-offset:2px}
button.go{border-color:var(--ok);color:var(--ok)}button.stop{border-color:var(--bad);color:var(--bad)}button.danger{border-color:var(--bad);color:var(--bad)}
button.go:hover:not(:disabled){background:rgba(0,255,170,.1)}button.stop:hover:not(:disabled),button.danger:hover:not(:disabled){background:rgba(255,56,96,.12);color:var(--bad);border-color:var(--bad)}
.shell{flex:1;min-height:0;display:grid;grid-template-columns:216px minmax(0,1fr)}
.nav{display:flex;flex-direction:column;gap:2px;padding:14px 10px;background:var(--panel);border-right:1px solid var(--line);overflow:auto}
.navhead{margin:14px 10px 6px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}.navhead:first-child{margin-top:2px}
.nav button{display:flex;align-items:center;gap:12px;text-align:left;width:100%;padding:9px 12px;border:1px solid transparent;border-left:3px solid transparent;background:none;color:var(--dim);border-radius:var(--r)}
.nav button i{font-style:normal;width:16px;text-align:center;opacity:.8}
.nav button:hover:not(:disabled){background:var(--panel2);color:var(--txt);border-color:transparent;border-left-color:var(--line)}
.nav button.on{background:var(--panel2);color:var(--cy);border-left-color:var(--cy)}
.nbadge{margin-left:auto;background:var(--warn);color:#000;border-radius:99px;font-size:11px;font-weight:700;padding:0 7px;line-height:18px}.nbadge[hidden]{display:none}
.navfoot{margin-top:auto;padding:12px 10px 2px;font-size:11.5px;overflow-wrap:anywhere;border-top:1px solid var(--line)}
main{min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px 22px}
.page{display:none;min-height:0}.page.on{display:flex;flex-direction:column;flex:1;overflow:auto}
.page.console.on>section{flex:1}
.grid1,.grid2,.grid3{display:grid;gap:14px;align-items:start}
.grid1{grid-template-columns:minmax(0,860px)}.grid2{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}.grid3{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.page.grid.on>.grid1,.page.grid.on>.grid2{padding-bottom:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.tile{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:var(--r);padding:11px 14px}
.tile .k{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}.tile .v{font:600 18px/1.4 "Segoe UI",sans-serif;margin-top:2px}
.tile.ok{border-left-color:var(--ok)}.tile.ok .v{color:var(--ok)}.tile.bad{border-left-color:var(--bad)}.tile.bad .v{color:var(--bad)}.tile.warn{border-left-color:var(--warn)}.tile.warn .v{color:var(--warn)}
@media (max-width:820px){.shell{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.nav{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;border-right:none;border-bottom:1px solid var(--line);padding:8px}.navhead,.navfoot{display:none}.nav button{width:auto;white-space:nowrap;border-left:none;border-bottom:3px solid transparent}.nav button.on{border-bottom-color:var(--cy)}main{padding:12px}}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;min-height:0}
section>h2{margin:0;padding:10px 14px;font:600 12px/1 "Segoe UI",sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
.col{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto}.col>section{flex:none}
.pad{padding:12px 14px}
.grp{margin:0 0 4px;color:var(--mg);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.btns{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}.btns button{text-align:left}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px}.kv span{min-width:0;overflow-wrap:anywhere}.kv span:nth-child(odd){color:var(--dim)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}
.tabs{display:flex;gap:4px;padding:8px 10px 0;border-bottom:1px solid var(--line);align-items:center;flex-wrap:wrap}
.tab{padding:6px 12px;border:1px solid transparent;border-bottom:none;border-radius:var(--r) var(--r) 0 0;color:var(--dim);cursor:pointer;background:none}
.tab.on{color:var(--cy);border-color:var(--line);background:var(--panel2)}
.tools{display:flex;gap:6px;margin-left:auto;padding-bottom:6px;align-items:center;flex-wrap:wrap}
.chip{padding:3px 10px;font-size:12px;border-radius:99px}.chip.on{border-color:var(--cy);color:var(--cy)}
input[type=text],select{background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:var(--r);padding:6px 9px;font:inherit}
.arow{display:flex;align-items:center;gap:8px;padding:5px 0;flex-wrap:wrap}.arow label{display:flex;align-items:center;gap:8px;flex:1;min-width:150px}
.arow input[type=text]{width:64px;padding:3px 6px}.bk{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;font-size:12.5px;padding:3px 0}
.chgrow{display:grid;grid-template-columns:auto auto 1fr;gap:10px;padding:2px 0;border-bottom:1px dotted var(--line)}.chgrow .k{color:var(--mg);min-width:120px}.chgrow.bad .d{color:var(--bad)}
#log,#act,#chg{flex:1;min-height:200px;overflow:auto;padding:8px 12px;font:12.5px/1.5 Consolas,"Cascadia Mono",monospace;background:var(--bg);border-radius:0 0 var(--r) var(--r);white-space:pre-wrap;word-break:break-word}
.ln.error{color:var(--bad)}.ln.warn{color:var(--warn)}.ln.dash{color:var(--cy)}.ln .ts{color:var(--dim);margin-right:8px}
.res{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:6px 0;border-bottom:1px solid var(--line);align-items:center}
.res:last-child{border:none}.res .p{font-family:Consolas,monospace;font-size:12.5px;word-break:break-all}.res .m{grid-column:1;font-size:12px}
.res .b{display:flex;gap:2px}.res .b button{padding:1px 7px;font-size:12px}
.prog{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:7px 0;border-bottom:1px solid var(--line);align-items:center}.prog:last-child{border:none}
.prog select{padding:3px 6px;font-size:12px}.prog .n{grid-column:1/-1;font-size:12px}
.st-done{color:var(--ok)}.st-testing{color:var(--warn)}.st-doing{color:var(--cy)}
#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:30;max-width:420px}
.t{padding:10px 14px;border:1px solid var(--line);border-left:3px solid var(--cy);background:var(--panel2);border-radius:var(--r);box-shadow:0 8px 30px rgba(0,0,0,.4)}
.t.bad{border-left-color:var(--bad)}.t.ok{border-left-color:var(--ok)}
dialog{background:var(--panel);color:var(--txt);border:1px solid var(--bad);border-radius:var(--r);padding:0;max-width:460px;width:92vw}
dialog::backdrop{background:rgba(0,0,0,.65)}dialog .in{padding:18px 20px}dialog h3{margin:0 0 8px;color:var(--bad)}dialog .row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.upk{padding:8px 0;border-bottom:1px solid var(--line)}.upk:last-child{border:none}.upk .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.upk .h b{flex:1}
.upk .m{font-size:12px;margin:2px 0 6px;overflow-wrap:anywhere}.upk .bb{display:flex;gap:6px;flex-wrap:wrap}.upk select{max-width:100%;font-size:12px;padding:3px 6px}
#pdlg{max-width:860px;border-color:var(--cy)}#pdlg h3{color:var(--cy)}#pdbody{max-height:min(55vh,480px);overflow:auto;margin-top:8px;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;word-break:break-all}.pgsum{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#rdlg{max-width:820px;border-color:var(--cy)}#rdlg h3{color:var(--cy)}#rbody{max-height:min(52vh,460px);overflow:auto;margin-top:10px}#rsum{color:var(--dim);font-size:13px}
.rpg{border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;margin:0 0 8px;background:var(--bg)}.rpg .h{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.rpg .h b{font-size:13px}.rpg .mg{font:12px/1.5 Consolas,monospace;color:var(--warn);margin-top:4px;word-break:break-all}.rpg details{margin-top:4px}.rpg summary{cursor:pointer;color:var(--dim);font-size:12px}.rpg .fl{font:12px/1.5 Consolas,monospace;white-space:pre-wrap;word-break:break-all}
#udlg{max-width:760px;border-color:var(--cy)}#udlg h3{color:var(--cy)}#ulist{white-space:pre-wrap;max-height:260px;overflow:auto;font:12px/1.5 Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:6px 8px;margin-top:8px}
.a-add{color:var(--ok)}.a-overwrite{color:var(--cy)}.a-conflict{color:var(--warn)}.a-keep,.a-protected{color:var(--dim)}.a-blocked{color:var(--bad)}
.pl{margin:6px 0 0;padding-left:18px}.pl li{margin:2px 0}
.t.warn{border-left-color:var(--warn)}
button.warnbtn{border-color:var(--warn);color:var(--warn);font-weight:600}#bWatch[hidden]{display:none}
.upk a{color:var(--cy)}
.pill.unreachable,.pill.unknown{color:var(--warn);border-color:var(--warn)}.pill.unreachable .dot,.pill.unknown .dot{background:var(--warn)}
.vform{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 12px;margin-top:10px}.vform label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dim)}
.vform input{color:var(--txt);width:100%}
.vrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
#vkeybox,#vtrustbox{margin-top:10px;display:flex;flex-direction:column;gap:6px}#vkeybox[hidden],#vtrustbox[hidden]{display:none}
#vkeytxt{width:100%;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:var(--r);padding:6px 8px;font:12px/1.4 Consolas,monospace;resize:vertical}
#vtrustbox input{width:100%}
.mono{font:12.5px/1.5 Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;word-break:break-word}
#vpsout,#vlog{min-height:140px;max-height:320px;overflow:auto;padding:8px 12px;background:var(--bg);border-radius:0 0 var(--r) var(--r)}
.mono-inline{font:12px Consolas,monospace;background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.chk{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:5px 0;border-bottom:1px solid var(--line)}.chk:last-child{border:none}
.chk .b{align-self:start;font:700 11px/18px "Segoe UI",sans-serif;letter-spacing:.08em;min-width:44px;text-align:center;border-radius:99px;border:1px solid var(--line)}
.chk .b.ok{color:var(--ok);border-color:var(--ok)}.chk .b.warn{color:var(--warn);border-color:var(--warn)}.chk .b.bad{color:var(--bad);border-color:var(--bad)}
.chk .f{grid-column:2;font-size:12px;color:var(--dim)}
#vpstiles{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.page.vwiz.on{overflow:hidden;gap:14px}
.vsteps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;flex:none}
.vstep{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--dim);border-radius:var(--r);display:flex;flex-direction:column;min-width:0}
.vstep[data-state=doing]{border-top-color:var(--cy)}.vstep[data-state=done]{border-top-color:var(--ok)}.vstep[data-state=bad]{border-top-color:var(--bad)}.vstep[data-state=locked]{opacity:.62}
.vstep>header{display:flex;align-items:center;gap:12px;padding:14px 16px 6px}
.vnum{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font:700 16px "Segoe UI",sans-serif;color:var(--dim);flex:none}
.vstep[data-state=doing] .vnum{border-color:var(--cy);color:var(--cy)}.vstep[data-state=done] .vnum{border-color:var(--ok);color:var(--ok)}
.vtt{flex:1;min-width:0}.vtt h3{margin:0;font:700 17px/1.2 "Segoe UI",sans-serif;letter-spacing:.02em}.vtt span{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.vbadge{font:700 10.5px/1 "Segoe UI",sans-serif;letter-spacing:.12em;padding:5px 9px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.vstep[data-state=doing] .vbadge{color:var(--cy);border-color:var(--cy)}.vstep[data-state=done] .vbadge{color:var(--ok);border-color:var(--ok)}.vstep[data-state=bad] .vbadge{color:var(--bad);border-color:var(--bad)}
.vbody{padding:6px 16px 8px;flex:1;min-height:92px;font-size:13px;line-height:1.5}.vbody p{margin:4px 0}
.vlist{margin:2px 0 6px;padding-left:18px}.vlist li{margin:2px 0}
.vstep>footer{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 16px 14px;border-top:1px solid var(--line)}
button.big{padding:9px 20px;font-size:14px;font-weight:700}
.vopt{display:flex;gap:8px;align-items:center;margin-top:6px;color:var(--txt)}
.vlive{display:flex;align-items:center;gap:8px;color:var(--dim);font-size:12.5px;margin-right:auto}.vlive i{width:9px;height:9px;border-radius:50%;background:var(--dim);display:inline-block}
.vlive.up{color:var(--ok)}.vlive.up i{background:var(--ok)}.vlive.wait i{background:var(--warn);animation:vpulse 1.2s infinite}
@keyframes vpulse{50%{opacity:.25}}
.vfprow{display:flex;gap:6px;margin-top:4px}.vfprow input{flex:1;min-width:0}
.vfin{margin-top:8px;font-size:12.5px}.vfin div{padding:2px 0}
.vpanel{flex:1;min-height:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden}
.vtabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);flex:none;overflow-x:auto}
.vtab{background:none;border:none;border-bottom:2px solid transparent;border-radius:0;padding:11px 14px;color:var(--dim);white-space:nowrap}
.vtab.on{color:var(--cy);border-bottom-color:var(--cy)}
.vpane{display:none;flex:1;min-height:0;overflow:auto;padding:12px 14px;position:relative}.vpane.on{display:block}
.vpane[data-t=out].on,.vpane[data-t=log].on{display:flex;flex-direction:column;padding:0}
#vpsout,#vlog{flex:1;min-height:0;max-height:none;border-radius:0}
.vlivechk{padding:6px 12px;border-bottom:1px solid var(--line);display:flex;gap:6px;align-items:center}
@media (max-width:1100px){.vsteps{grid-template-columns:1fr}.page.vwiz.on{overflow:auto}.vpanel{min-height:360px}}
/* ---- one-screen layout for every page (wide windows only; small windows keep the scrolling layout) ---- */
@media (min-width:1100px) and (min-height:820px){
.ph2{margin:0 0 12px;padding-bottom:10px}
.page.on{overflow:hidden;min-height:0}
.page.grid.on>.grid1,.page.grid.on>.grid2{flex:1;min-height:0;padding-bottom:0}
.page.grid.on>.grid1{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);align-items:stretch}
.page.grid.on>.grid2{grid-template-rows:minmax(0,1fr);align-items:stretch}
.page.grid.on>.grid1>section,.page.grid.on>.grid2>section{min-height:0}
.page.grid.on section>.pad{overflow:auto;min-height:0;flex:1}
#reslist,#updlist{overflow:auto;min-height:0}
#reslist{flex:1}

/* monitor */
.page.mon.on{gap:10px;overflow:hidden}
.page.mon .tiles{margin:0;gap:10px;grid-template-columns:repeat(6,minmax(0,1fr))}.page.mon .tile{padding:8px 12px}.page.mon .tile .v{font-size:17px}
.mongrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(440px,1.15fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:10px;flex:1;min-height:0}
.mcard{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,var(--panel2),var(--panel));padding:8px 10px}
.mcard .mh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px}.mcard .mh .dim{font-size:12px}.mcard .mh select{margin-left:auto;font-size:12px}
.mcard canvas{flex:1;min-height:0;width:100%;display:block}.rr .bd{color:var(--bad)}.mres{min-width:0}
.mres{grid-column:3;grid-row:1 / span 2}
#restab{font:12px/1.35 Consolas,monospace;overflow:auto;flex:0 1 auto;max-height:40%;min-height:60px;margin-top:4px}
#restab .rr{display:grid;grid-template-columns:minmax(0,1fr) 66px 52px 52px 62px 36px;gap:6px;padding:2px 4px;border-radius:5px;cursor:pointer;align-items:center}
#restab .rr:hover{background:var(--panel2)}#restab .rr.sel{outline:1px solid var(--cy)}#restab .rh{white-space:nowrap;cursor:default;color:var(--dim)}#restab .rr span:nth-child(n+2){text-align:right}
#restab .rr .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.monbanner{border:1px solid var(--warn);color:var(--warn);border-radius:10px;padding:8px 12px;font-size:13px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.monbanner[hidden]{display:none}
.rng{display:inline-flex;gap:4px;margin-right:8px}.rng button{padding:3px 10px;font-size:12px;border-radius:99px}.rng button.on{border-color:var(--cy);color:var(--cy)}
@media (max-height:820px){.page.mon .tile .s{display:none}}
/* dashboard */
.page[data-page=dash].on{display:grid;grid-template-rows:auto auto auto minmax(0,1fr);gap:12px;align-content:start}
.page[data-page=dash] .ph2{margin:0}
.page[data-page=dash] .attn{margin:0;display:flex;flex-direction:column;min-height:0;max-height:200px}
.page[data-page=dash] .attn .pad,#attn{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:8px;overflow:auto;min-height:0;align-content:start}
.page[data-page=dash] .ai{padding:6px 10px}
.page[data-page=dash] .ai .tx b,.page[data-page=dash] .ai .tx span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.page[data-page=dash] .tiles{margin:0;gap:10px}
.page[data-page=dash] .tile{padding:8px 12px}.page[data-page=dash] .tile .v{font-size:16px}
.page[data-page=dash] .grid3{display:grid;min-height:0;gap:12px;align-items:stretch;
  grid-template-columns:minmax(0,1fr) minmax(0,1.55fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);
  grid-template-areas:"st ac au" "st ac rc"}
.page[data-page=dash] .grid3>section:nth-child(1){grid-area:st}.page[data-page=dash] .grid3>section:nth-child(2){grid-area:ac}
.page[data-page=dash] .grid3>section:nth-child(3){grid-area:au}.page[data-page=dash] .grid3>section:nth-child(4){grid-area:rc}
.page[data-page=dash] .grid3>section{min-height:0}
.page[data-page=dash] .kv{gap:7px 14px;font-size:12.5px}
.page[data-page=dash] .grid3 section>h2{padding:8px 14px}.page[data-page=dash] .grid3 .pad{padding:8px 14px}
#actions{column-width:170px;column-gap:14px}
#actions .btns{flex-direction:column;gap:4px;margin-bottom:8px;break-inside:avoid}
#actions .btns button{text-align:left;padding:4px 10px;font-size:12px;width:100%}
#actions .grp{margin:4px 0 5px;break-after:avoid}
@media (max-height:1010px){.page[data-page=dash] .recent .rr:nth-child(n+5){display:none}}
.page[data-page=dash] .recent .rr .d{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* progress: cards in a grid */
#progress{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:8px;align-content:start}
#progress .grp{grid-column:1/-1;margin:6px 0 0}
#progress .prog{margin:0;padding:5px 12px}
#progress .grp{margin:2px 0 0}
#progress .prog .n{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* resources: one line per resource, several columns */
.rg{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin:10px 14px 0}
.rg>.rgh{grid-column:1/-1}
.res2{grid-template-columns:30px minmax(0,1fr) auto;gap:4px 8px;padding:5px 6px;border-right:1px solid var(--line)}
.res2 .b button{padding:1px 6px}
.res2 .m{grid-column:2;font-size:11.5px}
.res2 .m.dim:not(:has(.warn)){display:none}
.res2 .p{font-size:12px}
/* progress */
.page[data-page=progress].on .pad{padding-top:10px}
}
.gchk{display:flex;gap:8px;align-items:flex-start;padding:3px 0}.gchk.warn span{color:var(--warn)}
#prog{position:fixed;top:72px;left:50%;transform:translateX(-50%);width:min(520px,92vw);display:flex;flex-direction:column;gap:8px;z-index:28;pointer-events:none}
#prog .pi{pointer-events:auto}
.pi{background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--cy);border-radius:var(--r);padding:9px 12px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.pi.pi-ok{border-left-color:var(--ok)}.pi.pi-bad{border-left-color:var(--bad)}
.pi .ph{display:flex;gap:8px;align-items:baseline}.pi .pl1{font-weight:600;flex:1;min-width:0;overflow-wrap:anywhere}
.pi .px{background:none;border:none;color:var(--dim);padding:0 4px}
.pi .ps{font-size:12px;color:var(--dim);margin-top:2px;overflow-wrap:anywhere}
.pbar{height:8px;background:var(--bg);border:1px solid var(--line);border-radius:99px;overflow:hidden;margin-top:6px;position:relative}
.pbar i{display:block;height:100%;background:var(--cy);width:0;transition:width .15s}
.pbar.ind i{position:absolute;top:0;width:35%;animation:pslide 1.2s linear infinite}
@keyframes pslide{from{left:-35%}to{left:100%}}
.pi-ok .pbar i{background:var(--ok)}.pi-bad .pbar i{background:var(--bad)}
.pi-ok .pbar.ind i,.pi-bad .pbar.ind i{position:static;animation:none;width:100%}
.pi .pn{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-top:3px;color:var(--dim)}.pi .pn span{min-width:0;overflow-wrap:anywhere}
.page[data-page=resources] .grid1,.page[data-page=progress] .grid1,.page[data-page=backups] .grid1{grid-template-columns:minmax(0,1fr)}
.rtools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}.rtools input[type=text]{flex:1;min-width:200px}
.rg{border:1px solid var(--line);border-left:3px solid var(--cy);border-radius:var(--r);margin:12px 14px 0;overflow:hidden}
.rg.g-custom{border-left-color:var(--ok)}.rg.g-system{border-left-color:var(--cy)}.rg.g-other{border-left-color:var(--mg)}
.rgh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:9px 12px;background:var(--panel2);cursor:pointer;user-select:none}
.rgh b{letter-spacing:.04em}.rgh .hint{font-size:12px;flex:1;min-width:200px}
.rgh:focus-visible{outline:2px solid var(--cy);outline-offset:-2px}
.res2{display:grid;grid-template-columns:44px minmax(220px,2fr) minmax(180px,1.4fr) auto;gap:4px 12px;padding:6px 12px;border-top:1px solid var(--line);align-items:center}
.res2 .n{color:var(--dim);font-size:12px;text-align:right}.res2 .p{font:12.5px Consolas,monospace;overflow-wrap:anywhere}.res2 .m{font-size:12.5px;overflow-wrap:anywhere}
.res2 .b{display:flex;gap:2px}.res2 .b button{padding:1px 8px;font-size:12px}
.res2:hover{background:var(--panel2)}
.badge{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:11.5px;line-height:18px}
.badge.warn{border-color:var(--warn)}.badge.bad{border-color:var(--bad)}
.radd{display:flex;gap:6px;padding:12px 14px;border-top:1px solid var(--line);margin-top:12px}
@media (max-width:820px){.res2{grid-template-columns:36px minmax(0,1fr) auto}.res2 .m{grid-column:2/-1}}
.pov{display:flex;height:12px;border-radius:99px;overflow:hidden;border:1px solid var(--line);background:var(--bg)}
.pov i{display:block;height:100%}.pov .s-done{background:var(--ok)}.pov .s-testing{background:var(--warn)}.pov .s-doing{background:var(--cy)}.pov .s-todo{background:var(--line)}
.pleg{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;margin:8px 0 12px}
.pleg span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--line)}
.pleg .s-done::before{background:var(--ok)}.pleg .s-testing::before{background:var(--warn)}.pleg .s-doing::before{background:var(--cy)}
.prog{border-left:3px solid var(--line);padding-left:10px}.prog.p-done{border-left-color:var(--ok)}.prog.p-testing{border-left-color:var(--warn)}.prog.p-doing{border-left-color:var(--cy)}
.prog .gh{grid-column:1/-1;color:var(--mg);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-top:6px}
.recent .rr{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:4px 0;border-bottom:1px dotted var(--line);font-size:12.5px}.recent .rr:last-child{border:none}
.recent .rr.bad .d{color:var(--bad)}.recent .rr .d{overflow-wrap:anywhere}
.bsum{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-size:13px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
/* ---- v2 professional layout (VNR palette) ---- */
body{background-image:radial-gradient(1000px 420px at 0% -12%,rgba(47,168,255,.11),transparent),radial-gradient(1000px 420px at 100% -12%,rgba(194,59,255,.10),transparent)}
header{position:relative;gap:14px;padding:10px 22px;background:linear-gradient(180deg,var(--panel2),var(--panel))}
header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--grad);opacity:.9}
.brand{display:flex;align-items:center;gap:12px}
.logo{height:38px;width:auto;display:block;border-radius:6px;background:#05060c;padding:2px 6px;border:1px solid var(--line)}
.bt{display:flex;flex-direction:column;gap:3px}
h1{font:700 15px/1 "Segoe UI",sans-serif;letter-spacing:.2em;text-transform:uppercase}
h1 b{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
#sub{font-size:11.5px;letter-spacing:.06em}
.pill{background:rgba(255,255,255,.02)}
button{border-radius:7px;font-weight:500}
button:hover:not(:disabled){box-shadow:0 0 0 3px var(--glow)}
button.go{background:rgba(43,224,160,.08)}button.stop,button.danger{background:rgba(255,77,109,.07)}
.nav{padding:16px 12px;background:linear-gradient(180deg,var(--panel),var(--bg))}
.navhead{margin:18px 10px 6px;font-size:10px;letter-spacing:.24em}
.nav button{padding:10px 12px;font-weight:500}
.nav button.on{background:linear-gradient(90deg,rgba(47,168,255,.16),rgba(194,59,255,.07));color:var(--txt);border-left-color:var(--cy);box-shadow:inset 0 0 0 1px var(--line)}
.nav button.on i{color:var(--cy);opacity:1}
main{padding:20px 26px}
.ph2{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.ph2 .pt{margin:0;font:600 22px/1.15 "Segoe UI",sans-serif;letter-spacing:.01em}
.ph2 .pd{font-size:12.5px;color:var(--dim);margin-top:4px;max-width:70ch}
.ph2 .chips2{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.cp{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border:1px solid var(--line);border-radius:99px;background:var(--panel);font-size:12px;color:var(--dim);white-space:nowrap}
.cp b{color:var(--txt);font-weight:600}.cp::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dim)}
.cp.ok::before{background:var(--ok);box-shadow:0 0 7px var(--ok)}.cp.warn::before{background:var(--warn)}.cp.bad::before{background:var(--bad);box-shadow:0 0 7px var(--bad)}.cp.info::before{background:var(--cy)}
.cp.ok b{color:var(--ok)}.cp.warn b{color:var(--warn)}.cp.bad b{color:var(--bad)}
section{border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.28);overflow:hidden}
section>h2{padding:12px 16px;font-size:11.5px;letter-spacing:.18em;color:var(--txt);background:linear-gradient(180deg,var(--panel2),var(--panel));position:relative}
section>h2::before{content:"";width:3px;height:13px;border-radius:2px;background:var(--grad)}
.pad{padding:14px 16px}
.tiles{gap:12px}
.tile{position:relative;border:1px solid var(--line);border-left:1px solid var(--line);border-radius:10px;padding:13px 16px 12px;background:linear-gradient(180deg,var(--panel2),var(--panel));overflow:hidden}
.tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dim)}
.tile.ok::before{background:var(--ok)}.tile.bad::before{background:var(--bad)}.tile.warn::before{background:var(--warn)}
.tile .v{font:700 20px/1.3 "Segoe UI",sans-serif;letter-spacing:.02em}
.tile .s{font-size:11.5px;color:var(--dim);margin-top:1px;overflow-wrap:anywhere}
.attn{margin-bottom:14px}.attn .pad{display:flex;flex-direction:column;gap:8px}
.ai{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:8px;background:var(--panel2)}
.ai.bad{border-left-color:var(--bad)}.ai.ok{border-left-color:var(--ok)}.ai.info{border-left-color:var(--cy)}
.ai .tx{flex:1;min-width:0}.ai .tx b{display:block}.ai .tx span{font-size:12px;color:var(--dim);overflow-wrap:anywhere}
.ai button{padding:4px 12px;font-size:12.5px}
.kv{gap:0 18px}.kv span{padding:7px 0;border-bottom:1px solid var(--line)}.kv span:nth-last-child(-n+2){border-bottom:none}
.btns{gap:6px}.btns button{padding:8px 12px}
.tabs{padding:10px 12px 0;background:var(--panel2)}
.tab{padding:8px 14px;font-weight:500}.tab.on{background:var(--bg);color:var(--txt);border-color:var(--line);box-shadow:inset 0 2px 0 var(--cy)}
#log,#act,#chg{padding:10px 14px;line-height:1.55}
.ln.error{background:rgba(255,77,109,.07)}.ln.warn{background:rgba(255,200,61,.06)}
.chgrow{padding:6px 2px}
.bk{grid-template-columns:70px 1fr auto;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center}
.bk:nth-child(odd){background:rgba(255,255,255,.015)}
.bk span:first-child{font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.1em}
.bsum{gap:12px}.bsum>span{padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}
.upk{padding:12px 14px;margin-bottom:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}.upk:last-child{border:1px solid var(--line);margin-bottom:0}
.upk .h b{font-size:14px}
.upk .bb{margin-top:6px}
.badge.ok{border-color:var(--ok);color:var(--ok)}
.rg{border-radius:10px;margin:14px 16px 0}.rgh{padding:11px 14px}
.res2{padding:8px 14px}
.prog{padding:10px 12px 10px 14px;border:1px solid var(--line);border-left-width:3px;border-radius:8px;margin-bottom:6px;background:var(--panel2)}.prog:last-child{border-bottom:1px solid var(--line)}
.prog .gh{border:none;padding:0;margin-top:10px;background:none}
.pov{height:14px}.pov i{background-image:linear-gradient(180deg,rgba(255,255,255,.18),transparent)}
.pbar i{background:var(--grad)}
dialog{border-radius:12px;box-shadow:0 20px 70px rgba(0,0,0,.6)}
#udlg{border-color:var(--cy)}
.cfm{margin-top:12px;padding:10px 12px;border:1px dashed var(--warn);border-radius:8px;background:rgba(255,200,61,.05)}
.cfm label{display:block;font-size:12.5px;margin-bottom:6px}.cfm label b{color:var(--warn);font-family:Consolas,monospace;letter-spacing:.1em}
.cfm input{width:100%;letter-spacing:.12em;font-family:Consolas,monospace}
.cfm .okmark{font-size:12px;margin-top:5px;min-height:16px}
#uyes:disabled{opacity:.35}
input[type=text]:focus,select:focus{border-color:var(--cy)}
#toast .t,.pi{border-radius:10px}
.page.grid>*,.page.console>.ph2{flex-shrink:0}
@media (max-width:820px){main{padding:12px 14px}.ph2 .chips2{margin-left:0}.logo{height:30px}.bt{display:none}}
/* ================= CV skin: ChoomVille house look (overrides; no layout changes) ================= */
:root,:root:not([data-theme=dark]){--bg:#030814;--panel:#06102a;--panel2:#0a1736;--line:rgba(0,195,255,.28);--txt:#eaf6ff;--dim:#8d9bb3;--cy:#00c3ff;--mg:#ff00b4;--ok:#3df0a0;--warn:#ffd400;--bad:#ff3b5c;--r:0;--grad:linear-gradient(90deg,#00c3ff,#ff00b4);--glow:rgba(0,195,255,.16);--disp:"Rajdhani","Bahnschrift SemiCondensed","Bahnschrift","Segoe UI",sans-serif;--mono:"JetBrains Mono","Cascadia Mono","Consolas",monospace;--cut:14px}
body{font:13px/1.5 var(--mono);background-color:var(--bg);background-image:radial-gradient(900px 420px at 0% -10%,rgba(0,195,255,.10),transparent),radial-gradient(900px 420px at 100% -10%,rgba(255,0,180,.08),transparent),linear-gradient(rgba(0,195,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,195,255,.035) 1px,transparent 1px);background-size:auto,auto,32px 32px,32px 32px}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;background:repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
button,input,select,textarea,section,.tile,.mcard,.t,dialog,.pill,.chip,.badge,.rpg,.vstep,.vpanel,.vbadge,.nbadge,.rng button,.mono-inline,.chk .b,#ulist,#vkeytxt,.pi,.vnum,.nav button,.monbanner,#toast .t{border-radius:0!important}
/* header */
header{background:linear-gradient(180deg,#07102a,#040a1e);border-bottom:1px solid var(--cy);box-shadow:0 1px 0 rgba(255,0,180,.55),0 6px 24px rgba(0,195,255,.12);position:relative}
header::after{content:"";position:absolute;left:0;bottom:-1px;width:120px;height:2px;background:var(--mg);box-shadow:0 0 10px var(--mg)}
h1{font:700 19px/1 var(--disp);letter-spacing:.3em;text-shadow:0 0 12px rgba(0,195,255,.5)}
h1 b{color:var(--cy)}h1 i{color:var(--mg)}
.pill{font:700 12px/1 var(--disp);letter-spacing:.2em;text-transform:uppercase;padding:6px 12px;background:rgba(0,0,0,.35);clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))}
.dot{border-radius:0;width:8px;height:8px;transform:rotate(45deg)}
.pill.online .dot{box-shadow:0 0 8px var(--ok)}
/* buttons */
button{font:600 12px/1.2 var(--disp);letter-spacing:.14em;text-transform:uppercase;background:rgba(0,195,255,.05);border:1px solid var(--cy);color:var(--cy);padding:8px 16px;transition:.12s}
button:hover:not(:disabled){background:rgba(0,195,255,.16);color:#fff;border-color:var(--cy);box-shadow:0 0 14px rgba(0,195,255,.45),inset 0 0 10px rgba(0,195,255,.15)}
button:disabled{opacity:.35}
button.go{border-color:var(--ok);color:var(--ok);background:rgba(61,240,160,.06)}
button.go:hover:not(:disabled){background:rgba(61,240,160,.18);color:#fff;box-shadow:0 0 14px rgba(61,240,160,.45)}
button.stop,button.danger{border-color:var(--bad);color:var(--bad);background:rgba(255,59,92,.06)}
button.stop:hover:not(:disabled),button.danger:hover:not(:disabled){background:rgba(255,59,92,.2);color:#fff;box-shadow:0 0 14px rgba(255,59,92,.5)}
button.warnbtn{border-color:var(--warn);color:var(--warn);background:rgba(255,212,0,.07)}
button.big{background:linear-gradient(90deg,rgba(0,195,255,.28),rgba(255,0,180,.28));color:#fff;border-color:var(--cy)}
button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--mg);outline-offset:2px}
/* nav */
.nav{background:linear-gradient(180deg,#050d24,#030814);border-right:1px solid var(--line);padding:14px 0}
.navhead{font:700 11px/1 var(--disp);letter-spacing:.28em;color:var(--cy);opacity:.75;margin:18px 14px 8px}
.navhead::before{content:"▾ ";color:var(--mg)}
.nav button{font:600 13px/1.2 var(--disp);letter-spacing:.16em;color:var(--dim);background:none;border:0;border-left:3px solid transparent;padding:10px 14px;box-shadow:none}
.nav button:hover:not(:disabled){background:rgba(0,195,255,.07);color:#fff;border-left-color:var(--cy);box-shadow:none}
.nav button.on{background:linear-gradient(90deg,rgba(255,0,180,.20),rgba(255,0,180,0));color:#fff;border-left-color:var(--mg);box-shadow:none;text-shadow:0 0 10px rgba(255,0,180,.6)}
.nav button i{color:var(--cy);opacity:1}
.nbadge{background:var(--warn);color:#000;font-family:var(--disp)}
.navfoot{font-size:11px;color:var(--dim);border-top:1px solid var(--line)}
/* panels */
section{background:linear-gradient(180deg,rgba(10,23,54,.92),rgba(5,12,32,.96));border:1px solid var(--line);box-shadow:none;position:relative;clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));overflow:hidden}
section::before{content:"";position:absolute;left:0;top:0;width:16px;height:16px;border-top:2px solid var(--cy);border-left:2px solid var(--cy);pointer-events:none;z-index:2}
section::after{content:"";position:absolute;right:0;bottom:0;width:16px;height:16px;border-bottom:2px solid var(--mg);border-right:2px solid var(--mg);pointer-events:none;z-index:2}
section>h2{font:700 13px/1 var(--disp);letter-spacing:.26em;color:var(--cy);background:linear-gradient(90deg,rgba(0,195,255,.12),transparent 70%);border-bottom:1px solid var(--line);padding:12px 18px}
section>h2::before{content:"▾";width:auto;height:auto;background:none;color:var(--mg);font-size:12px;margin-right:2px}
.ph2{border-bottom:1px solid var(--line)}
.ph2 h2,.ph2 h3{font-family:var(--disp);letter-spacing:.24em;text-transform:uppercase}
h3,h4{font-family:var(--disp);letter-spacing:.16em;text-transform:uppercase}
/* tiles */
.tile{background:linear-gradient(180deg,rgba(10,23,54,.9),rgba(5,12,32,.95));border:1px solid var(--line);border-left:3px solid var(--cy);clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,0 100%);box-shadow:none}
.tile .k{font:700 10.5px/1 var(--disp);letter-spacing:.26em;color:var(--dim)}
.tile .v{font:700 20px/1.3 var(--disp);letter-spacing:.06em;color:#fff}
.tile.ok{border-left-color:var(--ok)}.tile.bad{border-left-color:var(--bad)}.tile.warn{border-left-color:var(--warn)}
/* tabs, chips, badges */
.tabs{border-bottom:1px solid var(--line)}
.tab,.vtab{font:700 12px/1 var(--disp);letter-spacing:.2em;text-transform:uppercase;background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);box-shadow:none}
.tab:hover:not(:disabled),.vtab:hover:not(:disabled){background:none;color:#fff;box-shadow:none}
.tab.on,.vtab.on{color:var(--cy);border-bottom-color:var(--mg);text-shadow:0 0 10px rgba(0,195,255,.5)}
.chip,.badge,.vbadge{font:700 10.5px/1 var(--disp);letter-spacing:.18em;text-transform:uppercase;border:1px solid var(--mg);color:var(--mg);background:rgba(255,0,180,.07);padding:3px 8px}
/* inputs */
input,select,textarea,#vkeytxt{font:12.5px var(--mono);background:#020612;color:var(--txt);border:1px solid var(--line);box-shadow:inset 0 0 12px rgba(0,0,0,.6)}
input:focus,select:focus,textarea:focus,input[type=text]:focus,select:focus{border-color:var(--cy);box-shadow:inset 0 0 12px rgba(0,0,0,.6),0 0 10px rgba(0,195,255,.35);outline:none}
/* dialogs, toasts */
dialog{background:linear-gradient(180deg,#0a1736,#050c20);border:1px solid var(--bad);box-shadow:0 0 40px rgba(0,195,255,.18);clip-path:polygon(0 0,calc(100% - 20px) 0,100% 20px,100% 100%,20px 100%,0 calc(100% - 20px))}
dialog::backdrop{background:rgba(1,4,12,.82)}
dialog h3{font-family:var(--disp);letter-spacing:.2em}
#pdlg,#rdlg,#udlg{border-color:var(--cy)}
.t{background:#07112b;border:1px solid var(--line);border-left:3px solid var(--cy);box-shadow:0 0 24px rgba(0,195,255,.18)}
/* lists, rows, code */
.res,.prog,.upk,.chk{border-bottom:1px solid rgba(0,195,255,.14)}
.res .p,.mono,#ulist,#pdbody,#rbody .mg{font-family:var(--mono)}
#ulist,.rpg,#vpsout,#vlog{background:#020612;border:1px solid var(--line)}
.rpg{border-left:3px solid var(--mg)}
.mono-inline{background:#020612;border:1px solid var(--line);color:var(--cy)}
.chk .b{font-family:var(--disp);letter-spacing:.14em}
/* wizard / monitor */
.vstep{background:linear-gradient(180deg,rgba(10,23,54,.9),rgba(5,12,32,.96));border:1px solid var(--line);border-top:3px solid var(--dim);clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%)}
.vstep[data-state=doing]{border-top-color:var(--cy)}.vstep[data-state=done]{border-top-color:var(--ok)}.vstep[data-state=bad]{border-top-color:var(--bad)}
.vtt h3{font:700 18px/1.1 var(--disp);letter-spacing:.14em}
.vnum{font-family:var(--disp);transform:rotate(45deg)}.vnum{overflow:visible}
.vpanel{background:rgba(5,12,32,.92);border:1px solid var(--line)}
.mcard{background:linear-gradient(180deg,rgba(10,23,54,.9),rgba(3,8,22,.96));border:1px solid var(--line);border-top:2px solid var(--cy);clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)}
.mcard .mh{font:700 12px/1.2 var(--disp);letter-spacing:.18em;text-transform:uppercase;color:var(--cy)}
#restab .rr.sel{outline:1px solid var(--mg);background:rgba(255,0,180,.08)}
#restab .rh{font-family:var(--disp);letter-spacing:.14em;text-transform:uppercase;color:var(--cy);opacity:.7}
.rng button.on{border-color:var(--mg);color:var(--mg);background:rgba(255,0,180,.1)}
.monbanner{background:rgba(255,212,0,.06)}
/* scrollbars */
*{scrollbar-width:thin;scrollbar-color:#0a6f91 #030814}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:#030814}::-webkit-scrollbar-thumb{background:#0a6f91}::-webkit-scrollbar-thumb:hover{background:var(--cy)}
::selection{background:var(--mg);color:#fff}
.mcard .mh .dim,.mcard .mh span{font-family:var(--mono);text-transform:none;letter-spacing:0;color:var(--dim);font-weight:400;font-size:11.5px}#resname{white-space:nowrap}
@media (max-width:1300px){.mongrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(380px,1.1fr)}#restab .rr{grid-template-columns:minmax(0,1fr) 62px 50px 50px 58px 32px;gap:4px}#restab .rh{font-size:10px;letter-spacing:0}}
button{letter-spacing:.1em}#updhist button,.upk button{white-space:nowrap;flex:none}section>h2 .dim,section>h2 span{letter-spacing:.04em;text-transform:none;font-family:var(--mono);font-weight:400;font-size:11px}

/* ===== build plan page (professional layout) ===== */
.pipe{list-style:none;margin:12px 0 4px;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;counter-reset:none}
.pn{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);background:var(--panel2);cursor:pointer;position:relative}
.pn:hover{border-color:var(--cy)}
.pnum{font:700 18px/1 var(--disp);color:var(--cy);min-width:22px;text-align:center}
.pnt{display:flex;flex-direction:column;gap:6px;min-width:0}.pnn{font-size:13px;line-height:1.2;overflow-wrap:anywhere}
.pn-done{border-left:3px solid var(--ok)}.pn-testing{border-left:3px solid var(--warn)}.pn-doing{border-left:3px solid var(--cy)}.pn-todo{border-left:3px solid var(--line)}
.pchip{font:700 10px/1 var(--disp);letter-spacing:.16em;text-transform:uppercase;padding:3px 7px;border:1px solid var(--line);color:var(--dim);white-space:nowrap;align-self:flex-start}
.pc-done{color:var(--ok);border-color:var(--ok)}.pc-testing{color:var(--warn);border-color:var(--warn)}.pc-doing{color:var(--cy);border-color:var(--cy)}
.pcard{border:1px solid var(--line);background:var(--panel2);margin-bottom:8px;border-left-width:3px}
.pk-done{border-left-color:var(--ok)}.pk-testing{border-left-color:var(--warn)}.pk-doing{border-left-color:var(--cy)}
.pcard>summary{display:flex;gap:12px;align-items:center;padding:10px 14px;cursor:pointer;list-style:none}
.pcard>summary::-webkit-details-marker{display:none}
.ptt{flex:1;min-width:0}.pttl{font-size:14px;font-weight:600}.pmeta{font-size:11.5px;margin-top:2px}
.pbody{padding:2px 14px 14px 50px;display:flex;flex-direction:column;gap:10px}
.pnote{margin:0;font-size:13px;line-height:1.45}
.plab{display:inline-block;font:700 10px/1 var(--disp);letter-spacing:.18em;color:var(--mg);margin-right:10px}
.pev,.pleft{font-size:12.5px;line-height:1.45}.pleft ul{margin:6px 0 0;padding-left:18px}.pleft li{margin:2px 0}
.pmini{display:flex;height:6px;background:var(--line);overflow:hidden}.pmini i{display:block;height:100%}
.pmini .s-done{background:var(--ok)}.pmini .s-testing{background:var(--warn)}.pmini .s-doing{background:var(--cy)}
.pkids{display:flex;flex-direction:column;gap:6px}.pkid{padding:7px 10px;border:1px solid var(--line);background:var(--bg)}
.pkh{display:flex;gap:10px;align-items:center}.pkt{flex:1;font-size:12.5px}
.pfoot{display:flex;gap:10px;align-items:center;justify-content:flex-end}.pfoot select,.pkh select{padding:3px 6px;font-size:12px}
.psg{margin:12px 0 4px;color:var(--mg);font:700 11px/1 var(--disp);letter-spacing:.16em;text-transform:uppercase}
.psrow{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--line);border-left-width:3px;margin-bottom:4px;background:var(--panel2)}
.psmain{min-width:0;flex:1}.pst{font-size:13px}.psn{font-size:11.5px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.psctl{display:flex;gap:8px;align-items:center}.psctl select{padding:3px 6px;font-size:12px}
@media (max-width:760px){.pbody{padding-left:14px}.psrow{flex-direction:column;align-items:stretch}}

.page[data-page=progress].on{overflow-y:auto}
.page.grid.on[data-page=progress]>.grid1{grid-template-rows:none;grid-auto-rows:max-content;align-items:start;align-content:start}
.page[data-page=progress] .grid1>section{min-height:auto;overflow:visible;flex:none}
.page.grid.on[data-page=progress] section>.pad{overflow:visible;flex:none;min-height:auto}
#progress{display:block}

/* ===== professional layer (final): flat, restrained, organised; activity dock in the left rail ===== */
html body{--bg:#0a0e18;--panel:#101624;--panel2:#141c2e;--line:#232d45;--txt:#e6eaf3;--dim:#8d97b0;--cy:#4da3ff;--mg:#8b7bff;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--r:6px;--disp:"Segoe UI",system-ui,sans-serif;--glow:transparent;--grad:linear-gradient(90deg,#4da3ff,#8b7bff)}
:root,:root:not([data-theme=dark]){--bg:#0a0e18;--panel:#101624;--panel2:#141c2e;--line:#232d45;--txt:#e6eaf3;--dim:#8d97b0;--cy:#4da3ff;--mg:#8b7bff;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--r:6px;--disp:"Segoe UI",system-ui,sans-serif;--glow:transparent;--grad:linear-gradient(90deg,#4da3ff,#8b7bff)}
html body *{clip-path:none!important;text-shadow:none!important}
html body{font:13.5px/1.5 "Segoe UI",system-ui,sans-serif;background:var(--bg);background-image:none}
html body button,html body input,html body select,html body textarea,html body section,html body .tile,html body .mcard,html body .t,html body dialog,html body .chip,html body .badge,html body .rpg,html body .vstep,html body .vpanel,html body .vbadge,html body .nbadge,html body .mono-inline,html body #ulist,html body #vkeytxt,html body .pi,html body .monbanner{border-radius:var(--r)!important}
html body .pill{border-radius:99px!important;font:600 12px/1 var(--disp);letter-spacing:.04em;text-transform:none;background:transparent;padding:6px 12px}
html body .dot{border-radius:50%;transform:none;width:8px;height:8px}
html body .pill.online .dot,html body .pill.starting .dot{box-shadow:none}
/* header */
html body header{background:var(--panel);border-bottom:1px solid var(--line);box-shadow:none;padding:10px 20px;gap:14px}
html body header::after{display:none}
html body h1{font:700 15px/1 var(--disp);letter-spacing:.14em}
html body h1 b{color:var(--txt)}html body h1 i{color:var(--cy)}
/* buttons */
html body button{font:600 12.5px/1.2 var(--disp);letter-spacing:.02em;text-transform:none;background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:7px 14px;box-shadow:none}
html body button:hover:not(:disabled){background:#1a2440;border-color:var(--cy);color:#fff;box-shadow:none}
html body button.go{background:rgba(52,211,153,.10);border-color:rgba(52,211,153,.55);color:var(--ok)}
html body button.go:hover:not(:disabled){background:rgba(52,211,153,.2);color:#fff;box-shadow:none}
html body button.stop,html body button.danger{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.5);color:var(--bad)}
html body button.stop:hover:not(:disabled),html body button.danger:hover:not(:disabled){background:rgba(248,113,113,.18);color:#fff;box-shadow:none}
html body button.warnbtn{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.5);color:var(--warn)}
html body button.big{background:var(--cy);border-color:var(--cy);color:#06101f}
html body button:focus-visible,html body input:focus-visible,html body select:focus-visible{outline:2px solid var(--cy);outline-offset:2px}
/* inputs */
html body input,html body select,html body textarea,html body #vkeytxt{background:#0a1020;border:1px solid var(--line);box-shadow:none}
html body input:focus,html body select:focus,html body textarea:focus{border-color:var(--cy);box-shadow:0 0 0 3px rgba(77,163,255,.18)}
/* panels */
html body section{background:var(--panel);border:1px solid var(--line);box-shadow:none}
html body section>h2{font:600 11.5px/1 var(--disp);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);padding:12px 16px;border-bottom:1px solid var(--line);background:transparent}
html body section>h2 span,html body section>h2 .dim{letter-spacing:0;text-transform:none;font-weight:400}
html body .pad{padding:14px 16px}
html body .tile{background:var(--panel);border:1px solid var(--line);box-shadow:none}
html body .mcard{background:var(--panel);border:1px solid var(--line);border-top:1px solid var(--line);box-shadow:none}
html body .mcard .mh{font:600 11.5px/1.2 var(--disp);letter-spacing:.1em;color:var(--dim)}
html body .vstep,html body .vpanel{background:var(--panel);box-shadow:none}
html body dialog{background:var(--panel);border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.55)}
html body dialog::backdrop{background:rgba(4,7,14,.72)}
html body dialog h3{font:600 16px/1.3 var(--disp);letter-spacing:0}
/* page headings */
html body .ph2{padding:2px 2px 14px;margin:0 0 4px;border-bottom:1px solid var(--line)}
html body .pt{font:600 21px/1.2 var(--disp);letter-spacing:0;text-transform:none;margin:0}
html body .pd{color:var(--dim);font-size:13px;margin-top:4px;max-width:78ch}
html body section::before,html body section::after{content:none!important;display:none}
html body section>h2::before{content:none!important}
.navdock [hidden],.dockclr[hidden]{display:none!important}
/* left rail */
html body .shell{grid-template-columns:272px minmax(0,1fr)}
html body .nav{background:var(--panel);border-right:1px solid var(--line);padding:14px 0 0;gap:0;overflow:hidden}
html body .navhead{font:600 10.5px/1 var(--disp);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);opacity:1;margin:16px 18px 6px}
html body .navhead:first-child{margin-top:2px}
html body .navhead::before{content:none}
html body .nav>button{font:500 13.5px/1.2 var(--disp);letter-spacing:0;text-transform:none;color:var(--dim);background:none;border:0;border-left:2px solid transparent;padding:9px 18px;margin:0;width:100%;border-radius:0!important}
html body .nav>button:hover:not(:disabled){background:rgba(77,163,255,.06);color:var(--txt);border-left-color:var(--line);box-shadow:none}
html body .nav>button.on{background:rgba(77,163,255,.10);color:#fff;border-left-color:var(--cy)}
html body .nav>button i{color:var(--dim);width:18px}html body .nav>button.on i{color:var(--cy)}
html body .nbadge{background:var(--warn);color:#1a1200;font:700 10.5px/1 var(--disp);margin-left:auto;padding:2px 6px}
html body .nav{display:flex;flex-direction:column}
/* activity dock: notifications and progress bars live under the menu */
.navdock{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;margin-top:14px;border-top:1px solid var(--line);background:rgba(0,0,0,.14)}
.dockhead{display:flex;align-items:center;gap:8px;padding:11px 18px 8px;font:600 10.5px/1 var(--disp);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.dockcount{min-width:18px;padding:2px 6px;border-radius:99px;background:var(--panel2);border:1px solid var(--line);font:600 10.5px/1 var(--disp);letter-spacing:0;color:var(--txt);text-align:center}
.dockcount:empty{display:none}
html body .dockclr{margin-left:auto;padding:3px 9px;font-size:11px;background:none}
.dockbody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 12px 10px;display:flex;flex-direction:column;gap:8px}
.dockempty{color:var(--dim);font-size:12px;padding:6px 6px 2px}
.dockgrp{font:600 10px/1 var(--disp);letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:6px 4px 0}
.navdock #prog,.navdock #toast{position:static;transform:none;width:auto;max-width:none;display:flex;flex-direction:column;gap:8px;pointer-events:auto;right:auto;bottom:auto;top:auto;left:auto;z-index:auto}
.navdock #prog:empty,.navdock #toast:empty{display:none}
html body .navdock .pi{padding:9px 11px;background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--cy);box-shadow:none;font-size:12.5px}
html body .navdock .pi.pi-ok{border-left-color:var(--ok)}html body .navdock .pi.pi-bad{border-left-color:var(--bad)}
html body .navdock .pi .pn{border:0;padding:0;margin:4px 0 0;background:none;cursor:default;display:flex;justify-content:space-between;gap:8px}
html body .navdock .t,html body .navdock .t.bad,html body .navdock .t.warn,html body .navdock .t.ok{color:var(--txt)}
.navdock .pi .pl1{font-size:12.5px}.navdock .pi .ps,.navdock .pi .pn{font-size:11.5px}
html body .pbar{height:6px;background:#0a1020;border:0}
html body .pbar i{background:var(--cy)}
html body .navdock .t{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:8px 10px;background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--cy);box-shadow:none;font-size:12.5px;line-height:1.4}
html body .navdock .t.bad{border-left-color:var(--bad)}html body .navdock .t.warn{border-left-color:var(--warn)}html body .navdock .t.ok{border-left-color:var(--ok)}
.navdock .t .tm{grid-column:1;overflow-wrap:anywhere}.navdock .t .tt{grid-column:1;font-size:11px;color:var(--dim)}
.navdock .t .tx{grid-column:2;grid-row:1/3;align-self:start;background:none;border:0;color:var(--dim);padding:0 2px;font-size:13px}
html body .navfoot{margin:0;padding:10px 18px;border-top:1px solid var(--line);font-size:11px;color:var(--dim);overflow-wrap:anywhere;flex:none}
@media (max-width:820px){
  html body .shell{grid-template-columns:1fr}
  html body .nav{flex-direction:row;overflow-x:auto}
  .navdock{position:fixed;left:8px;right:8px;bottom:8px;max-height:42vh;z-index:40;margin:0;border:1px solid var(--line);background:var(--panel);border-radius:var(--r)}
  .navdock:has(.dockempty:not([hidden])){display:none}
}
/* ===== VPS page: one button ===== */
.vsteps[hidden],.vheroBtns [hidden],.vaPhases[hidden]{display:none!important}
.vauto{padding:0!important}
.vhero{display:flex;gap:24px;align-items:center;justify-content:space-between;padding:20px 22px;flex-wrap:wrap}
.vheroText{flex:1 1 340px;min-width:0}.vheroText h3{margin:0 0 4px;font:600 20px/1.2 var(--disp);letter-spacing:0}
.vheroText p{margin:0;color:var(--dim);font-size:13px;max-width:70ch}
.vheroBtns{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:230px}
html body .vheroBtns button.big{padding:13px 22px;font-size:15px}
.vaPhases{list-style:none;margin:0;padding:6px 22px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:6px 28px}
.vaPhases li{display:grid;grid-template-columns:22px 1fr;gap:2px 10px;padding:7px 0;border-top:1px solid var(--line);align-items:baseline}
.vaPhases .ic{font-size:14px;text-align:center;color:var(--dim)}
.vaPhases .nm{font-weight:600;font-size:13.5px}.vaPhases .dt{grid-column:2;color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.vaPhases li[data-s=running] .ic{color:var(--cy);animation:vaspin 1s linear infinite;display:inline-block}
.vaPhases li[data-s=waiting] .ic{color:var(--warn)}.vaPhases li[data-s=done] .ic{color:var(--ok)}.vaPhases li[data-s=failed] .ic{color:var(--bad)}
.vaPhases li[data-s=failed] .dt{color:var(--bad)}.vaPhases li[data-s=skipped] .nm{color:var(--dim);font-weight:500}
.vaPhases li[data-s=pending] .nm{color:var(--dim);font-weight:500}
@keyframes vaspin{to{transform:rotate(360deg)}}
.vaNeed{margin:0 22px 14px;padding:14px 16px;border:1px solid var(--warn);border-left-width:4px;background:rgba(251,191,36,.07);border-radius:var(--r)}
.vaNeed h4{margin:0 0 6px;font:600 14px/1.3 var(--disp)}.vaNeed ol{margin:6px 0 10px;padding-left:20px}.vaNeed li{margin:3px 0}
.vaNeed .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}.vaNeed input{min-width:220px;flex:1}
.vaNeed code{display:block;margin:6px 0;padding:6px 8px;background:#0a1020;border:1px solid var(--line);border-radius:var(--r);font:12px var(--mono);overflow-wrap:anywhere}
.vaSummary{margin:0 22px 18px;padding:12px 16px;border:1px solid var(--line);border-left-width:4px;border-radius:var(--r);font-size:13.5px}
.vaSummary.ok{border-left-color:var(--ok);background:rgba(52,211,153,.07)}.vaSummary.bad{border-left-color:var(--bad);background:rgba(248,113,113,.07)}
.vhealth .vg{font:600 10.5px/1 var(--disp);letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:14px 0 6px}.vhealth .vg:first-child{margin-top:0}
.vhealth .vc{display:grid;grid-template-columns:54px 1fr;gap:2px 10px;padding:6px 0;border-top:1px solid var(--line);align-items:baseline}
.vhealth .vc .b{font:700 10.5px/1 var(--disp);letter-spacing:.1em;padding:3px 0;text-align:center;border-radius:4px;border:1px solid var(--line)}
.vhealth .vc .b.ok{color:var(--ok);border-color:var(--ok)}.vhealth .vc .b.warn{color:var(--warn);border-color:var(--warn)}.vhealth .vc .b.bad{color:var(--bad);border-color:var(--bad)}
.vhealth .vc .t{overflow-wrap:anywhere}.vhealth .vc .f{grid-column:2;color:var(--dim);font-size:12px}
.vserver .vrow{margin-top:10px}
.vgit .vgitIntro{margin:0 0 12px;color:var(--dim)}
.vgit .ghrepo{display:flex;gap:8px;align-items:center;margin-bottom:14px}.vgit .ghrepo label{font:600 10.5px/1 var(--disp);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}.vgit .ghrepo input{flex:1;min-width:0}
.vgit .ghcols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:900px){.vgit .ghcols{grid-template-columns:1fr}}
.vgit .ghbox{border:1px solid var(--line);border-radius:8px;padding:12px}.vgit .ghbox h4,.vgit .ghkey h4{margin:0 0 8px;font:600 10.5px/1 var(--disp);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.vgit .ghlines>div{display:grid;grid-template-columns:54px 1fr;gap:2px 10px;padding:4px 0;align-items:baseline}
.vgit .ghlines .b{font:700 10.5px/1 var(--disp);letter-spacing:.1em;padding:3px 0;text-align:center;border-radius:4px;border:1px solid var(--line);color:var(--dim)}
.vgit .ghlines .b.ok{color:var(--ok);border-color:var(--ok)}.vgit .ghlines .b.warn{color:var(--warn);border-color:var(--warn)}.vgit .ghlines .b.bad{color:var(--bad);border-color:var(--bad)}
.vgit .ghlines .gx{overflow-wrap:anywhere}
.vgit .ghkey{margin-top:12px;border:1px solid var(--warn);border-radius:8px;padding:12px}.vgit .ghkey ol{margin:0 0 8px;padding-left:20px}.vgit .ghkey textarea{width:100%;font:12px/1.4 var(--mono,monospace);resize:none}
.vgit .ghall{margin-top:14px;align-items:center}
.updall{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.upk .usrc{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0 2px}.upk .usrc input{flex:1;min-width:160px}.upk .usrc .dim{font-size:12px}
.vgit a{color:var(--acc,#7dd3fc);text-decoration:underline}

.vadv{margin-top:6px}.vadv>summary{cursor:pointer;padding:10px 4px;font:600 12.5px/1.2 var(--disp);color:var(--dim);list-style:none}
.vadv>summary::-webkit-details-marker{display:none}.vadv>summary::before{content:"\25B8  "}.vadv[open]>summary::before{content:"\25BE  "}
.vadv>summary .dim{font-weight:400;margin-left:8px}

/* VPS page scrolls as one column; dock buttons keep their natural width */
html body .page.vwiz.on{overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:14px;padding-bottom:28px}
html body .page.vwiz>section,html body .page.vwiz>details{flex:none;min-height:auto;overflow:visible}
html body .page.vwiz .vpanel{flex:none;min-height:360px;overflow:hidden}
html body .vheroText h3,html body .vaNeed h4{text-transform:none;letter-spacing:0}
html body .navdock .px,html body .navdock .tx{width:auto!important;flex:none;display:inline-block;padding:0 4px;text-align:center;border:0;background:none}
html body .navdock .pi .ph{display:flex;gap:8px;align-items:baseline}
/* =====================================================================================================
   CYBERPUNK SKIN v5 + page layouts ("cx" pages). Last in the file on purpose: it wins over the older layers.
   ===================================================================================================== */
:root,:root:not([data-theme=dark]),html body{
 --bg:#03050b;--bg2:#060a14;--panel:#0a101f;--panel2:#0f1830;--line:rgba(0,240,255,.26);--line2:rgba(255,255,255,.08);
 --txt:#e9f6ff;--dim:#8697b8;--cy:#00f0ff;--mg:#ff2a6d;--yl:#fcee0a;--ok:#39ff88;--warn:#fcee0a;--bad:#ff3355;--vi:#a855ff;--glow:rgba(0,240,255,.3);
 --r:0px;--cut:12px;--grad:linear-gradient(90deg,#00f0ff,#a855ff 55%,#ff2a6d);
 --disp:"Bahnschrift","Rajdhani","Segoe UI Semibold","Segoe UI",system-ui,sans-serif;
 --mono:"Cascadia Mono","Cascadia Code",Consolas,"Courier New",monospace;
 --cutp:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));
 --cutr:polygon(0 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%);
}
html body{color:var(--txt);font:13.5px/1.5 var(--disp);letter-spacing:.01em;background-color:var(--bg);
 background-image:radial-gradient(900px 480px at 6% -8%,rgba(0,240,255,.14),transparent 62%),radial-gradient(900px 480px at 100% -6%,rgba(255,42,109,.13),transparent 62%),linear-gradient(rgba(0,240,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,240,255,.04) 1px,transparent 1px);
 background-size:auto,auto,46px 46px,46px 46px;background-attachment:fixed}
html body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:300;background:repeating-linear-gradient(0deg,rgba(0,0,0,.20) 0 1px,transparent 1px 3px);mix-blend-mode:multiply;opacity:.7}
html body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:299;box-shadow:inset 0 0 140px rgba(0,0,0,.6)}
html body *{scrollbar-width:thin;scrollbar-color:#0b7f93 transparent}
html body ::-webkit-scrollbar{width:8px;height:8px}html body ::-webkit-scrollbar-thumb{background:#0b7f93}html body ::-webkit-scrollbar-thumb:hover{background:var(--cy)}html body ::-webkit-scrollbar-track{background:rgba(0,0,0,.25)}
html body ::selection{background:var(--mg);color:#fff}
.dim{color:var(--dim)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}

/* ---------- header ---------- */
html body header{position:relative;gap:12px;padding:9px 18px;background:linear-gradient(180deg,#081027,#040813);border-bottom:1px solid var(--line);box-shadow:0 8px 30px rgba(0,240,255,.08)}
html body header::after{content:"";display:block!important;position:absolute;left:0;right:0;bottom:-1px;height:2px;background:linear-gradient(90deg,var(--cy),var(--vi) 40%,var(--mg) 70%,var(--yl));box-shadow:0 0 12px rgba(0,240,255,.7)}
html body h1{font:700 17px/1 var(--disp);letter-spacing:.32em;text-transform:uppercase;color:var(--cy)!important;text-shadow:2px 0 rgba(255,42,109,.75),-2px 0 rgba(0,240,255,.35),0 0 14px rgba(0,240,255,.6)!important;animation:glitch 7s steps(1) infinite}
html body h1 b{color:var(--cy);-webkit-text-fill-color:currentColor;background:none}
html body #sub{color:var(--yl);letter-spacing:.3em;font:600 10.5px/1 var(--disp);text-transform:uppercase}
@keyframes glitch{0%,93%,100%{transform:none}94%{transform:translateX(-2px) skewX(-6deg)}96%{transform:translateX(2px)}98%{transform:translateX(-1px) skewX(4deg)}}
html body .logo{border:1px solid var(--line);background:#020510;border-radius:0!important;clip-path:var(--cutr)!important;height:36px}
html body .pill{font:700 12px/1 var(--disp);letter-spacing:.2em;text-transform:uppercase;padding:7px 14px;background:rgba(0,0,0,.4);border-radius:0!important;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px))!important}
html body .dot{border-radius:0;width:8px;height:8px;transform:rotate(45deg)}
html body .pill.online{color:var(--ok);border-color:var(--ok);box-shadow:0 0 14px rgba(57,255,136,.25)}html body .pill.online .dot{background:var(--ok);box-shadow:0 0 9px var(--ok)}
html body .pill.offline{color:var(--bad);border-color:var(--bad)}html body .pill.offline .dot{background:var(--bad);box-shadow:0 0 9px var(--bad)}
html body .who{font:600 12px/1 var(--mono);letter-spacing:.04em;text-transform:none;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-color:rgba(252,238,10,.5);color:var(--yl)}
html body .who:hover:not(:disabled){border-color:var(--yl);color:#fff;background:rgba(252,238,10,.12)}

/* ---------- buttons ---------- */
html body button{font:700 12px/1.15 var(--disp);letter-spacing:.13em;text-transform:uppercase;color:var(--cy);background:rgba(0,240,255,.06);border:1px solid rgba(0,240,255,.55);border-radius:0!important;padding:8px 15px;box-shadow:none;clip-path:var(--cutr)!important;transition:background .12s,color .12s,box-shadow .12s}
html body button:hover:not(:disabled){background:rgba(0,240,255,.2);color:#fff;border-color:var(--cy);box-shadow:0 0 16px rgba(0,240,255,.45),inset 0 0 12px rgba(0,240,255,.18)}
html body button:active:not(:disabled){transform:translateY(1px)}
html body button:disabled{opacity:.32;cursor:not-allowed}
html body button.go{color:var(--ok);border-color:rgba(57,255,136,.6);background:rgba(57,255,136,.07)}
html body button.go:hover:not(:disabled){background:rgba(57,255,136,.2);color:#fff;border-color:var(--ok);box-shadow:0 0 16px rgba(57,255,136,.45),inset 0 0 12px rgba(57,255,136,.15)}
html body button.stop,html body button.danger{color:var(--mg);border-color:rgba(255,42,109,.65);background:rgba(255,42,109,.08)}
html body button.stop:hover:not(:disabled),html body button.danger:hover:not(:disabled){background:repeating-linear-gradient(135deg,rgba(255,42,109,.34) 0 8px,rgba(255,42,109,.12) 8px 16px);color:#fff;border-color:var(--mg);box-shadow:0 0 16px rgba(255,42,109,.5)}
html body button.warnbtn{color:var(--yl);border-color:rgba(252,238,10,.6);background:rgba(252,238,10,.08)}
html body button.big{background:var(--yl);color:#0a0a00;border-color:var(--yl);box-shadow:0 0 18px rgba(252,238,10,.35)}
html body button.big:hover:not(:disabled){background:#fff86a;color:#000;box-shadow:0 0 26px rgba(252,238,10,.65)}
html body button:focus-visible,html body input:focus-visible,html body select:focus-visible{outline:2px solid var(--yl);outline-offset:2px}
html body button.busy{position:relative;color:transparent!important;pointer-events:none;text-shadow:none!important}
html body button.busy::after{content:"";position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid rgba(255,255,255,.25);border-top-color:var(--cy);border-radius:50%;animation:spin .7s linear infinite}
html body button.go.busy::after{border-top-color:var(--ok)}html body button.big.busy::after{border-top-color:#000;border-color:rgba(0,0,0,.2)}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---------- inputs ---------- */
html body input,html body select,html body textarea{font:12.5px var(--mono);background:#020612;color:var(--txt);border:1px solid var(--line);border-radius:0!important;box-shadow:inset 0 0 14px rgba(0,0,0,.65)}
html body input:focus,html body select:focus,html body textarea:focus{border-color:var(--cy);box-shadow:inset 0 0 14px rgba(0,0,0,.65),0 0 12px rgba(0,240,255,.3);outline:none}
html body input[type=checkbox]{accent-color:var(--cy)}

/* ---------- navigation rail ---------- */
html body .shell{grid-template-columns:240px minmax(0,1fr)}
html body .nav{background:linear-gradient(180deg,#050b1c,#030713);border-right:1px solid var(--line);padding:12px 0 0;box-shadow:inset -1px 0 0 rgba(255,42,109,.12)}
html body .navhead{font:700 10.5px/1 var(--disp);letter-spacing:.32em;text-transform:uppercase;color:var(--mg);margin:16px 18px 6px;opacity:.95}
html body .navhead::before{content:"// ";color:var(--cy)}
html body .nav>button{font:700 13px/1.2 var(--disp);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);background:none;border:0;border-left:3px solid transparent;padding:9px 18px;clip-path:none!important;box-shadow:none}
html body .nav>button i{color:var(--cy);opacity:.9}
html body .nav>button:hover:not(:disabled){background:linear-gradient(90deg,rgba(0,240,255,.1),transparent);color:#fff;border-left-color:var(--cy);box-shadow:none}
html body .nav>button.on{background:linear-gradient(90deg,rgba(252,238,10,.16),rgba(252,238,10,0) 85%);color:var(--yl);border-left-color:var(--yl);text-shadow:0 0 12px rgba(252,238,10,.55)!important;box-shadow:none}
html body .nav>button.on i{color:var(--yl)}
html body .nbadge{background:var(--yl);color:#000;font:800 10.5px/1 var(--disp);border-radius:0!important;padding:2px 6px}
html body .nbfail{background:var(--mg);color:#fff}
html body .navfoot{font:11px/1.4 var(--mono);color:var(--dim);border-top:1px solid var(--line)}

/* ---------- panels ---------- */
html body section{position:relative;background:linear-gradient(180deg,rgba(14,24,50,.9),rgba(6,11,25,.95));border:1px solid var(--line);border-radius:0!important;box-shadow:none;clip-path:var(--cutp)!important;overflow:hidden}
html body section::before{content:""!important;display:block!important;position:absolute;right:0;top:0;width:var(--cut);height:var(--cut);background:linear-gradient(45deg,transparent calc(50% - .7px),var(--cy) 50%,transparent calc(50% + .7px));pointer-events:none;z-index:3}
html body section::after{content:""!important;display:block!important;position:absolute;left:0;bottom:0;width:var(--cut);height:var(--cut);background:linear-gradient(45deg,transparent calc(50% - .7px),var(--mg) 50%,transparent calc(50% + .7px));pointer-events:none;z-index:3}
html body section>h2{position:relative;font:700 12.5px/1 var(--disp);letter-spacing:.24em;text-transform:uppercase;color:var(--cy);padding:12px 36px 11px 22px;background:linear-gradient(90deg,rgba(0,240,255,.13),transparent 70%);border-bottom:1px solid var(--line);flex:none}
html body section>h2::before{content:""!important;display:block!important;position:absolute;left:0;top:0;bottom:0;width:4px;height:auto;background:var(--yl);box-shadow:0 0 10px var(--yl)}
html body section>h2 span,html body section>h2 .dim{font:400 11px/1 var(--mono);letter-spacing:.02em;text-transform:none;color:var(--dim)}
html body .pad{padding:14px 18px}
html body .ph2{border-bottom:1px solid var(--line);padding:0 2px 10px;margin:0;position:relative;flex:none}
html body .ph2::after{content:"";position:absolute;left:0;bottom:-1px;width:90px;height:2px;background:var(--mg);box-shadow:0 0 10px var(--mg)}
html body .pt{font:700 24px/1.1 var(--disp);letter-spacing:.2em;text-transform:uppercase;color:#fff;text-shadow:0 0 16px rgba(0,240,255,.45)!important}
html body .pt::before{content:"> ";color:var(--yl);text-shadow:0 0 12px rgba(252,238,10,.6)!important}
html body .pd{color:var(--dim);font-size:12.5px;max-width:92ch}
@media (max-height:800px){html body .pd{display:none}html body .ph2{padding-bottom:8px}}
html body .cp{background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:0!important;clip-path:var(--cutr)!important;font:600 11.5px/1 var(--disp);letter-spacing:.08em;text-transform:uppercase;padding:6px 11px}
html body .cp b{font-family:var(--mono);letter-spacing:0;text-transform:none}
html body .cp::before{border-radius:0;transform:rotate(45deg)}

/* ---------- tiles ---------- */
html body .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0;flex:none}
html body .tile{position:relative;background:linear-gradient(180deg,rgba(15,26,54,.92),rgba(6,11,26,.96));border:1px solid var(--line);border-left:1px solid var(--line);border-radius:0!important;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)!important;padding:10px 14px 9px;overflow:hidden}
html body .tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dim)}
html body .tile.ok::before{background:var(--ok);box-shadow:0 0 10px var(--ok)}html body .tile.bad::before{background:var(--bad);box-shadow:0 0 10px var(--bad)}html body .tile.warn::before{background:var(--warn);box-shadow:0 0 10px var(--warn)}
html body .tile .k{font:700 10px/1 var(--disp);letter-spacing:.26em;color:var(--dim);text-transform:uppercase}
html body .tile .v{font:700 19px/1.25 var(--disp);letter-spacing:.07em;color:#fff;margin-top:3px;text-transform:uppercase;white-space:normal;overflow:hidden;word-break:break-word}
html body .tile.ok .v{color:var(--ok);text-shadow:0 0 12px rgba(57,255,136,.5)!important}html body .tile.bad .v{color:var(--bad);text-shadow:0 0 12px rgba(255,51,85,.55)!important}html body .tile.warn .v{color:var(--warn);text-shadow:0 0 12px rgba(252,238,10,.45)!important}
html body .tile .s{font:11px/1.3 var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- list rows / kv / items ---------- */
html body .kv span{padding:6px 0;border-bottom:1px solid var(--line2)}html body .kv span:nth-child(odd){color:var(--dim);text-transform:uppercase;font-size:11px;letter-spacing:.14em;align-self:center}
html body .ai{border:1px solid var(--line);border-left:3px solid var(--warn);background:rgba(0,0,0,.3);border-radius:0!important;clip-path:var(--cutr)!important}
html body .ai.bad{border-left-color:var(--bad)}html body .ai.ok{border-left-color:var(--ok)}html body .ai.info{border-left-color:var(--cy)}
html body .ai .tx b{letter-spacing:.04em}
html body .grp{font:700 11px/1 var(--disp);letter-spacing:.24em;color:var(--mg);text-transform:uppercase}
html body .recent .rr,html body .chgrow{border-bottom:1px dashed var(--line2)}
html body .badge,html body .chip,html body .vbadge,html body .pchip{border-radius:0!important;font:700 10.5px/1 var(--disp);letter-spacing:.16em;text-transform:uppercase;border:1px solid var(--mg);color:var(--mg);background:rgba(255,42,109,.07);padding:3px 8px}
html body .chip.on{border-color:var(--cy);color:var(--cy);background:rgba(0,240,255,.1)}
html body .badge.ok{border-color:var(--ok);color:var(--ok);background:rgba(57,255,136,.08)}html body .badge.warn{border-color:var(--warn);color:var(--warn);background:rgba(252,238,10,.08)}
html body .tab,html body .vtab{font:700 12px/1 var(--disp);letter-spacing:.2em;text-transform:uppercase;border:0;border-bottom:2px solid transparent;background:none;color:var(--dim);clip-path:none!important;box-shadow:none}
html body .tab.on,html body .vtab.on{color:var(--cy);border-bottom-color:var(--mg);background:rgba(0,240,255,.05);text-shadow:0 0 10px rgba(0,240,255,.5)!important}
html body .tab:hover:not(:disabled),html body .vtab:hover:not(:disabled){color:#fff;background:none;box-shadow:none}
html body #log,html body #act,html body #chg,html body #vpsout,html body #vlog{background:#020510;font:12.5px/1.55 var(--mono)}
html body .ln.error{color:var(--bad);background:rgba(255,51,85,.08)}html body .ln.warn{color:var(--warn);background:rgba(252,238,10,.06)}html body .ln.dash{color:var(--cy)}
html body dialog{background:linear-gradient(180deg,#0b1430,#050a1c);border:1px solid var(--cy);border-radius:0!important;box-shadow:0 0 60px rgba(0,240,255,.2);clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px))!important}
html body dialog::backdrop{background:rgba(1,3,10,.82)}html body dialog h3{font:700 16px/1.3 var(--disp);letter-spacing:.18em;text-transform:uppercase;color:var(--cy)}
html body #dlg h3{color:var(--mg)}

/* ---------- global activity bar + connection banner ---------- */
#gbar{position:relative;height:3px;background:transparent;flex:none;overflow:hidden;opacity:0;transition:opacity .2s;z-index:5}
#gbar.on{opacity:1;background:rgba(0,240,255,.12)}
#gbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cy),var(--vi),var(--mg));box-shadow:0 0 12px var(--cy);transition:width .25s}
#gbar.ind i{position:absolute;top:0;left:-30%;width:30%!important;animation:gslide 1.1s linear infinite}
@keyframes gslide{to{left:100%}}
#offbar{background:repeating-linear-gradient(135deg,#ff3355 0 14px,#b80f2e 14px 28px);color:#fff;font:700 12px/1 var(--disp);letter-spacing:.18em;text-transform:uppercase;text-align:center;padding:7px;flex:none}
#offbar[hidden]{display:none}

/* ---------- activity dock: reactive bars + Stop ---------- */
html body .navdock{background:rgba(0,0,0,.28);border-top:1px solid var(--line)}
html body .dockhead{font:700 10.5px/1 var(--disp);letter-spacing:.28em;color:var(--mg)}
html body .dockcount{border-radius:0;background:var(--mg);border:0;color:#fff;font-family:var(--mono)}
html body .dockstop{margin-left:auto;padding:4px 9px;font-size:10.5px;color:#fff;background:var(--mg);border-color:var(--mg);animation:pulsered 1.4s ease-in-out infinite}
html body .dockstop:hover:not(:disabled){background:#ff5c8d;box-shadow:0 0 16px rgba(255,42,109,.7)}
html body .dockstop[hidden]+.dockclr,html body .dockclr{margin-left:6px}
@keyframes pulsered{50%{box-shadow:0 0 14px rgba(255,42,109,.7)}}
html body .navdock .pi{position:relative;padding:9px 11px 8px;background:linear-gradient(180deg,rgba(14,24,50,.95),rgba(6,11,25,.98));border:1px solid var(--line);border-left:3px solid var(--cy);border-radius:0!important;clip-path:var(--cutr)!important;box-shadow:none;font-size:12.5px}
html body .navdock .pi .ph{display:flex;gap:8px;align-items:center}
html body .navdock .pi .pl1{font:700 12px/1.25 var(--disp);letter-spacing:.06em;text-transform:uppercase;flex:1;min-width:0}
html body .navdock .pi .ps{font:11.5px/1.35 var(--mono);color:var(--dim);margin-top:3px;overflow-wrap:anywhere}
html body .navdock .pi .pm{font:11px/1.3 var(--mono);color:var(--yl);margin-top:3px;overflow-wrap:anywhere;opacity:.9}
html body .navdock .pi .pm:empty{display:none}
html body .navdock .pi .pn{display:flex;justify-content:space-between;gap:8px;font:11px/1.3 var(--mono);color:var(--dim);margin-top:4px}
html body .psx{flex:none;padding:4px 9px;font-size:10.5px;letter-spacing:.12em;color:#fff;background:rgba(255,42,109,.22);border:1px solid var(--mg);white-space:nowrap}
html body .psx:hover:not(:disabled){background:var(--mg);box-shadow:0 0 14px rgba(255,42,109,.65)}
html body .psx:disabled{opacity:.7;color:var(--yl);border-color:var(--yl);background:rgba(252,238,10,.1)}
html body .pi .px{padding:0 4px;border:0;background:none;color:var(--dim);clip-path:none!important;font-size:13px}
html body .pbar{height:12px;margin-top:7px;background:repeating-linear-gradient(90deg,rgba(0,240,255,.12) 0 6px,transparent 6px 8px),#020612;border:1px solid var(--line);border-radius:0;overflow:hidden;position:relative}
html body .pbar i{display:block;height:100%;width:0;background:repeating-linear-gradient(135deg,rgba(255,255,255,.22) 0 6px,transparent 6px 12px),linear-gradient(90deg,var(--cy),var(--vi) 60%,var(--mg));background-size:24px 24px,100% 100%;animation:pstripe .8s linear infinite;box-shadow:0 0 12px rgba(0,240,255,.6);transition:width .2s}
@keyframes pstripe{to{background-position:24px 0,0 0}}
html body .pbar.ind i{position:absolute;top:0;left:-35%;width:35%;animation:pslide 1.1s linear infinite}
@keyframes pslide{from{left:-35%}to{left:100%}}
html body .navdock .pi.pi-ok{border-left-color:var(--ok)}html body .pi-ok .pbar i{background:var(--ok);box-shadow:0 0 10px var(--ok);animation:none}
html body .navdock .pi.pi-bad{border-left-color:var(--bad);animation:badflash 1.2s 2}html body .pi-bad .pbar i{background:var(--bad);box-shadow:0 0 10px var(--bad);animation:none}
html body .navdock .pi.pi-stop{border-left-color:var(--yl)}html body .pi-stop .pbar i{background:repeating-linear-gradient(135deg,#fcee0a 0 8px,#2a2600 8px 16px);animation:none;box-shadow:none}
html body .pi-ok .pbar.ind i,html body .pi-bad .pbar.ind i,html body .pi-stop .pbar.ind i{position:static;width:100%}
html body .navdock .pi.pi-stopping{border-left-color:var(--yl)}html body .pi-stopping .pbar i{background:repeating-linear-gradient(135deg,#fcee0a 0 6px,#5a5200 6px 12px);background-size:24px 24px;box-shadow:0 0 10px var(--yl)}
@keyframes badflash{50%{box-shadow:0 0 22px rgba(255,51,85,.7)}}
html body .navdock .t{background:rgba(0,0,0,.35);border:1px solid var(--line);border-left:3px solid var(--cy);border-radius:0!important;clip-path:var(--cutr)!important;box-shadow:none}

/* ---------- command log ---------- */
html body .seg{display:inline-flex;border:1px solid var(--line);flex:none}
html body .seg button{border:0;border-right:1px solid var(--line);padding:6px 11px;font-size:11px;letter-spacing:.1em;background:transparent;color:var(--dim);clip-path:none!important;box-shadow:none}
html body .seg button:last-child{border-right:0}
html body .seg button.on{background:rgba(0,240,255,.16);color:var(--cy);box-shadow:inset 0 -2px 0 var(--cy)}
.cltools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line);flex:none}
.cltools #clFind{flex:1 1 220px;min-width:160px}.cltools .sp{flex:1 1 0}
.clhead,.clt{display:grid;grid-template-columns:96px minmax(130px,200px) minmax(0,1fr) minmax(120px,170px);gap:12px;align-items:center}
.clhead{padding:7px 14px;font:700 10.5px/1 var(--disp);letter-spacing:.24em;text-transform:uppercase;color:var(--mg);border-bottom:1px solid var(--line);flex:none;background:rgba(0,0,0,.25)}
#cllist{flex:1;min-height:0;overflow:auto;background:#020510}
.clr{border-bottom:1px solid var(--line2);border-left:3px solid transparent}
.clr.st-failed{border-left-color:var(--bad);background:rgba(255,51,85,.05)}.clr.st-running{border-left-color:var(--cy);background:rgba(0,240,255,.05)}.clr.st-stopped{border-left-color:var(--yl);background:rgba(252,238,10,.04)}
.clr.child .clt{padding-left:30px}
.clt{padding:7px 14px;cursor:pointer;font-size:12.5px}.clt:hover{background:rgba(0,240,255,.07)}
.c-t{font:11.5px var(--mono);color:var(--dim)}
.c-w{min-width:0}.wb{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 8px;border:1px solid var(--line);font:700 11px/1.3 var(--disp);letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb i{font-style:normal}
.wb-person{color:var(--yl);border-color:rgba(252,238,10,.55);background:rgba(252,238,10,.07)}.wb-script{color:var(--vi);border-color:rgba(168,85,255,.6);background:rgba(168,85,255,.1)}.wb-system{color:var(--cy);border-color:rgba(0,240,255,.5);background:rgba(0,240,255,.07)}
.c-x{min-width:0;display:flex;flex-direction:column}.c-x b{font-weight:700;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.c-x .d{font:11.5px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-process .c-x b{color:var(--cy)}
.c-r{display:flex;flex-direction:column;gap:2px;align-items:flex-start}.c-r .m{font:11px var(--mono);color:var(--dim)}
.sc{font:800 10.5px/1 var(--disp);letter-spacing:.14em;padding:3px 7px;border:1px solid var(--line)}
.sc-ok{color:var(--ok);border-color:var(--ok);background:rgba(57,255,136,.08)}.sc-failed{color:var(--bad);border-color:var(--bad);background:rgba(255,51,85,.1)}.sc-stopped{color:var(--yl);border-color:var(--yl);background:rgba(252,238,10,.08)}.sc-running{color:var(--cy);border-color:var(--cy);background:rgba(0,240,255,.1);animation:pulsecy 1.1s ease-in-out infinite}.sc-unknown{color:var(--dim)}
@keyframes pulsecy{50%{box-shadow:0 0 12px rgba(0,240,255,.6)}}
.cld{padding:4px 14px 12px 128px;background:rgba(0,0,0,.35);border-top:1px dashed var(--line2)}
.cld dl{display:grid;grid-template-columns:140px minmax(0,1fr);gap:4px 14px;margin:6px 0}.cld dt{color:var(--mg);font:700 10.5px/1.7 var(--disp);letter-spacing:.16em;text-transform:uppercase}.cld dd{margin:0;overflow-wrap:anywhere}.cld dd.mono{font:12px/1.5 var(--mono);color:var(--cy);white-space:pre-wrap}
.cldb{display:flex;gap:8px;margin-top:6px}.cldb button{padding:5px 12px}
.clempty{padding:28px;text-align:center;color:var(--dim)}.clmore{display:block;margin:10px auto}
.clive{display:flex;gap:6px;align-items:center}

/* =================================== page layouts ("cx") =================================== */
html body main{padding:14px 18px 12px;min-width:0;min-height:0}
html body .page.cx.on{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:hidden}
html body .cxg{display:grid;gap:12px;flex:1;min-height:0}
html body .cxg>section{display:flex;flex-direction:column;min-height:0;min-width:0}
html body .cxg>section>.pad{flex:1;min-height:0;overflow:auto}
/* dashboard */
html body .dashg{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(260px,.9fr);grid-template-rows:auto minmax(150px,1fr) minmax(120px,.7fr);grid-template-areas:"attn attn act" "st auto act" "rec rec act"}
html body .dashg>section{min-height:0;min-width:0;display:flex;flex-direction:column}
html body .dashg>section>.pad,html body .dashg>section>div:not(.pad){overflow:auto;min-height:0}
html body .dashg .actsec #actions{overflow:auto;min-width:0}
html body .dashg #actions *{min-width:0;max-width:100%}
html body .dashg .attn{grid-area:attn;margin:0}html body .dashg .actsec{grid-area:act}html body .dashg .stsec{grid-area:st}html body .dashg .autosec{grid-area:auto}html body .dashg .recsec{grid-area:rec}
html body .dashg .attn>.pad{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px;max-height:30vh;overflow:auto;flex:none}
html body .dashg .ai{padding:6px 12px}
html body .dashg .ai .tx b,html body .dashg .ai .tx span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
html body .dashg #actions{columns:auto!important;column-width:auto!important;column-count:auto!important}
html body .dashg #actions .btns{flex-direction:row;flex-wrap:wrap;gap:6px;margin-bottom:8px}
html body .dashg #actions .btns button{width:auto;padding:6px 11px;font-size:11px;text-align:left}
html body .dashg .kv{font-size:12.5px}
/* backups */
html body .bkg{grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"do list" "full list"}
html body .bkg .bkdo{grid-area:do}html body .bkg .bklist{grid-area:list}html body .bkg .bkfulls{grid-area:full}
html body .bkbtns{display:flex;gap:8px;flex-wrap:wrap}.bkfull{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}.bkfull .dim{font-size:12px}
html body .bkdo .bsum{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 0}html body .bsum>span{border:1px solid var(--line);background:rgba(0,0,0,.3);padding:6px 12px;border-radius:0}.bkwhere{margin-top:8px;font:11px var(--mono)}
/* updates */
html body .updg{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;grid-template-areas:"packs watch" "packs pg"}
html body .updg>section:nth-child(1){grid-area:packs}html body .updg>#watchsec{grid-area:watch}html body .updg>#pgsec{grid-area:pg}
/* resources */
html body .resg{grid-template-columns:minmax(0,1fr) minmax(280px,340px);grid-template-rows:minmax(0,1fr);align-items:stretch}
html body .reslistsec #reslist{flex:1;min-height:0;overflow:auto;padding-bottom:8px}
html body .resaddsec{align-self:start}html body .radd{display:flex;flex-direction:column;gap:8px;padding:0;border:0;margin:0}html body .radd select{width:100%}.resnote{margin-top:12px;font-size:12px;line-height:1.5}
/* progress */
html body .progg{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"plan plan" "steps sys"}
html body .progg .plansec{grid-area:plan}html body .progg .stepsec{grid-area:steps}html body .progg #progsys{grid-area:sys}
html body .progg .plansec>.pad{max-height:34vh}
/* command log */
html body .clsec{flex:1;min-height:0;display:flex;flex-direction:column}
/* console */
html body .page.console.on section{flex:1;min-height:0}
/* VPS: scrolls as a two-column board */
html body .page.cx.vwiz.on{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);grid-auto-rows:min-content;align-content:start;overflow:auto;gap:12px;padding-bottom:20px}
html body .page.vwiz>.ph2{grid-column:1/-1}html body .page.vwiz>.vauto{grid-column:1/-1}html body .page.vwiz>.vhealth{grid-column:1;grid-row:3/span 2}
html body .page.vwiz>.vserver{grid-column:2;grid-row:3}html body .page.vwiz>.vgit{grid-column:2;grid-row:4}html body .page.vwiz>.vadv,html body .page.vwiz>.vsteps{grid-column:1/-1}
html body .page.vwiz>section,html body .page.vwiz>details{flex:none;min-height:auto;overflow:visible}
html body .page.vwiz>section{overflow:hidden}
html body .page.vwiz .vauto{padding:0!important}
html body .vheroBtns button.big{padding:12px 22px;font-size:14px}
html body .vaNeed,html body .vaSummary{border-radius:0}
html body .vadv>summary{font:700 12px/1.2 var(--disp);letter-spacing:.2em;text-transform:uppercase;color:var(--cy)}
/* monitor */
html body .page.mon.on{display:flex;flex-direction:column;gap:10px;overflow:hidden}
html body .mcard{background:linear-gradient(180deg,rgba(14,24,50,.9),rgba(6,11,25,.95));border:1px solid var(--line);border-top:2px solid var(--cy);border-radius:0!important;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)!important}
html body .mcard .mh{font:700 11.5px/1.2 var(--disp);letter-spacing:.2em;text-transform:uppercase;color:var(--cy)}
html body .mcard .mh .dim,html body .mcard .mh span{font-family:var(--mono);letter-spacing:0;text-transform:none;color:var(--dim);font-weight:400}
html body .rng button.on{border-color:var(--mg);color:var(--mg);background:rgba(255,42,109,.1)}

/* progress page bits */
html body .pov{border:1px solid var(--line);border-radius:0;height:14px}html body .pov i{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.14) 0 6px,transparent 6px 12px)}
html body .pn{border:1px solid var(--line);background:rgba(0,0,0,.28);border-radius:0}
html body .pcard,html body .upk,html body .rg,html body .psrow,html body .prog,html body .rpg{border-radius:0!important}
html body .upk{background:rgba(0,0,0,.28);border:1px solid var(--line)}
html body .rg{border:1px solid var(--line);border-left:3px solid var(--cy)}html body .rgh{background:rgba(0,240,255,.07);letter-spacing:.04em}

/* ---------- small windows: stack everything, let the page scroll ---------- */
@media (max-width:1000px),(max-height:640px){
 html body .page.cx.on{overflow:auto;display:flex}
 html body .cxg{display:flex;flex-direction:column;flex:none;overflow:visible}
 html body .cxg>section{flex:none;overflow:hidden}
 html body .cxg>section>.pad,html body .reslistsec #reslist{overflow:visible}
 html body .dashg .attn>.pad{max-height:none}
 html body .page.cx.vwiz.on{display:flex;flex-direction:column}
 #cllist{min-height:320px}
 html body .page.mon.on{overflow:auto}
}
@media (max-width:1000px){
 html body .shell{grid-template-columns:1fr}
 html body .nav{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:0;border-right:0;border-bottom:1px solid var(--line)}
 html body .navhead,html body .navfoot{display:none}
 html body .nav>button{white-space:nowrap;border-left:0;border-bottom:3px solid transparent;width:auto;padding:10px 14px}
 html body .nav>button.on{border-bottom-color:var(--yl);background:rgba(252,238,10,.08)}
 html body main{padding:10px 12px}
 html body .pt{font-size:19px}
 html body h1{font-size:13px;letter-spacing:.2em}html body .bt{display:none}
 .clhead{display:none}.clt{grid-template-columns:1fr auto;gap:4px 10px}.clt .c-t{grid-column:1}.clt .c-r{grid-column:2;grid-row:1/span 2;align-items:flex-end}.clt .c-w{grid-column:1}.clt .c-x{grid-column:1/-1}
 .cld{padding-left:14px}.cld dl{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){html body h1,#gbar i,html body .pbar i,html body .dockstop,.sc-running{animation:none!important}}
html body .vtabs,html body .vtab{max-width:100%}html body .vtabs{overflow-x:auto;flex-wrap:nowrap}html body .vtab{flex:none}
html body .navdock .pi .ph{flex-wrap:wrap}
html body .navdock .pi .psx{width:auto!important;min-width:0;flex:none;margin:0}
html body .navdock .pi .pl1{flex:1 1 90px;word-break:normal;overflow-wrap:anywhere}
html body .navdock .pi .px[hidden]{display:none!important}
html body .navdock .pi .px{width:auto!important;flex:none}
html body #bStopAll{white-space:nowrap;padding:4px 8px;font-size:10px}
html body #bEmerg{background:repeating-linear-gradient(135deg,rgba(255,51,85,.28) 0 8px,rgba(0,0,0,.45) 8px 16px);color:#fff;border:1px solid var(--bad);font-weight:800;letter-spacing:.16em;white-space:nowrap;text-shadow:0 0 8px rgba(255,51,85,.9)!important}
html body #bEmerg:hover:not(:disabled){background:var(--bad);box-shadow:0 0 22px rgba(255,51,85,.85);color:#fff}
html body #bEmerg:active:not(:disabled){transform:scale(.97)}
html body .tab.ping::after{content:"";display:inline-block;width:7px;height:7px;margin-left:7px;border-radius:50%;background:var(--mg);box-shadow:0 0 8px var(--mg);vertical-align:middle}
html body #bEmerg{letter-spacing:.07em;font-size:11px;padding:7px 9px}
@media (max-width:1500px){html body header>button,html body header .pill{padding-left:9px;padding-right:9px;letter-spacing:.07em;font-size:11px}html body header{gap:8px}html body header h1,html body header .brand{letter-spacing:.14em}}
html body .updg{grid-template-rows:minmax(0,1fr) auto auto;grid-template-areas:"packs watch" "packs self" "packs pg"}
html body .updg>#selfsec{grid-area:self;min-height:0}html body .updg>#watchsec>.pad,html body .updg>#selfsec>.pad{overflow:auto;max-height:100%}
html body .selfhead{font:700 13px/1.3 var(--disp);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}
html body .selfhead.ok b{color:var(--ok);text-shadow:0 0 10px rgba(57,255,136,.5)}html body .selfhead.warn b{color:var(--warn)}html body .selfhead.bad b{color:var(--bad)}
html body .selfnote{font-size:12px;margin:2px 0}html body .selfrow2{font:12px/1.4 var(--mono)}
html body .selffiles{margin:6px 0;border:1px solid var(--line)}html body .selff{display:flex;justify-content:space-between;gap:10px;padding:3px 8px;font:12px var(--mono)}
html body .selff.ok span:first-child{color:var(--ok)}html body .selff.diff span:first-child{color:var(--warn)}
html body .selfin{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}html body .selfin input:first-child{flex:1 1 200px;min-width:0}
html body .selfbtns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}html body .selfhelp{font-size:11.5px;margin-top:8px}
html body .updg{grid-template-rows:minmax(110px,.8fr) minmax(200px,1.5fr) minmax(120px,.9fr)}
html body .updg>section{display:flex;flex-direction:column;min-height:0}
html body .updg>#watchsec>.pad,html body .updg>#selfsec>.pad,html body .updg>#pgsec>.pad{overflow:auto;min-height:0;flex:1 1 auto}
html body .selfbtns button,html body .selfin button{padding:5px 10px}
html body .updg{grid-template-rows:auto minmax(100px,1fr) auto;grid-template-areas:"packs self" "packs watch" "packs pg"}
html body .selfin{flex-wrap:nowrap}html body .selfin input:first-child{flex:1 1 auto}html body .selfin input:nth-child(2){flex:0 0 74px;width:74px}
html body .selfhelp{display:none}
html body .updg>#selfsec>.pad{overflow:visible}
@media (min-height:900px){html body .selfhelp{display:block}}
html body .updg>#pgsec .dim:last-child{display:none}
html body .selfzip{margin-top:12px;padding-top:8px;border-top:1px dashed var(--line)}html body .selfziph{font:700 11px var(--disp);letter-spacing:.2em;text-transform:uppercase;color:var(--mg)}html body .selfzipt{font-size:12px;margin-top:3px}

/* mods page + brand */
html body .logo.rnd{height:54px;width:54px;padding:0;border:0;background:none;border-radius:50%!important;clip-path:none!important;box-shadow:0 0 14px rgba(120,80,255,.45)}
html body #sub{color:var(--cy);letter-spacing:.08em;font-size:12px;max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:none}
html body #sub:hover{color:var(--mg)}
html body .modgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:12px;align-items:start}
html body .modwide{grid-column:1/-1}
.modrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.modname{flex:1;min-width:200px;font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.modhelp{margin-top:10px;font-size:12px;flex-basis:100%}
.modtog{display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid var(--line)}
.modtog .mt{flex:1}.modtog button{min-width:64px}
.modit{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.modit .ml{flex:1;min-width:0}.modit .mh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.modsub{margin:12px 0 6px;font-weight:700;letter-spacing:.08em;font-size:12px;color:var(--cy)}
.modadd{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}.modadd input{flex:1;min-width:180px}
#ninp{width:100%;margin-top:8px}#nerr{color:var(--bad);margin-top:8px;min-height:1em;font-size:12.5px}
html body .page[data-page=mods].on{overflow-y:auto;display:block}html body .page[data-page=mods] .modgrid{padding-bottom:16px}
/* resources list: one column of full-width rows, nothing overlaps */
html body .rg{display:block;margin:12px 14px 0}
html body .rg>.rgh{grid-column:auto}
html body .res2{display:grid;grid-template-columns:44px minmax(0,1.7fr) minmax(0,1fr) max-content;gap:4px 12px;padding:6px 12px;border-right:0;border-top:1px solid var(--line);align-items:center;min-width:0}
html body .res2 .n{grid-column:1;text-align:right}
html body .res2 .p{grid-column:2;min-width:0;overflow-wrap:anywhere}
html body .res2 .m{grid-column:3;min-width:0;overflow-wrap:anywhere}
html body .res2 .m.dim:not(:has(.warn)){visibility:hidden}
html body .res2 .b{grid-column:4;display:flex;gap:4px;flex:none;justify-self:end}
html body .res2 .b button{padding:1px 8px;min-width:30px}
@media (max-width:820px){html body .res2{grid-template-columns:36px minmax(0,1fr) max-content}html body .res2 .m{grid-column:2/-1;grid-row:2}html body .res2 .m.dim:not(:has(.warn)){display:none}html body .res2 .b{grid-column:3;grid-row:1}}
/* updates page: sections take the height they need, the page scrolls - nothing is cut off or overlaps */
html body .page[data-page=updates].on{overflow-y:auto}
html body .updg{display:grid;flex:none;overflow:visible;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);grid-template-rows:auto auto 1fr;grid-template-areas:"packs self" "packs watch" "packs pg";align-items:start;align-content:start;padding-bottom:16px}
html body .updg>section{height:auto;min-height:0;overflow:visible}
html body .updg>section>.pad,html body .updg>#watchsec>.pad,html body .updg>#selfsec>.pad,html body .updg>#pgsec>.pad{overflow:visible;max-height:none;flex:none}
html body .updg>#pgsec .dim:last-child{display:block}
html body .selfhelp{display:block}
@media (max-width:1100px){html body .updg{grid-template-columns:minmax(0,1fr);grid-template-areas:"self" "watch" "pg" "packs"}}
html body #vcmd{max-width:none;width:min(860px,94vw)}
html body #vcmd h3{margin:0 0 4px}
html body #vcmdSt{margin-bottom:8px;font-size:12.5px}
html body #vcmdOut{height:min(52vh,420px);overflow:auto;padding:8px 12px;background:#020510;border:1px solid var(--line);font:12.5px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
html body #vcmd .row{flex-wrap:wrap}
html body #bVpsEmerg{background:repeating-linear-gradient(135deg,rgba(255,51,85,.28) 0 8px,rgba(0,0,0,.45) 8px 16px);color:#fff;border:1px solid var(--bad);font-weight:800;letter-spacing:.07em;font-size:11px;padding:7px 9px;white-space:nowrap;text-shadow:0 0 8px rgba(255,51,85,.9)!important}
html body #bVpsEmerg:hover:not(:disabled){background:var(--bad);box-shadow:0 0 22px rgba(255,51,85,.85);color:#fff}
html body #bVpsEmerg:active:not(:disabled){transform:scale(.97)}
html body #bVpsStop{white-space:nowrap}
@media (max-width:1500px){html body header{gap:5px}html body header>button,html body header .pill{padding:6px 7px;letter-spacing:.03em;font-size:10.5px}html body #bEmerg,html body #bVpsEmerg{letter-spacing:.03em;font-size:10.5px;padding:6px 7px}}
/* ---- Server + Settings pages, sidebar website link ---- */
html body .page[data-page=server].on,html body .page[data-page=settings].on{overflow-y:auto;display:block}
html body .srvg{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);grid-template-areas:"form prev" "form live";gap:14px;align-items:start;margin:12px 14px 0}
html body .srvg>section{height:auto;min-height:0;overflow:visible}
html body .srvg>section>.pad{overflow:visible;max-height:none;flex:none}
html body .srvprev{grid-area:prev}html body .srvlivesec{grid-area:live}html body .srvform{grid-area:form}
html body .spname{font:600 22px/1.25 var(--disp);overflow-wrap:anywhere;margin-bottom:8px}
html body .spdesc{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--txt);margin-bottom:10px;min-height:1.4em}
html body .spmeta{display:flex;gap:6px;flex-wrap:wrap}
html body .spchip{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--dim)}
html body .spchip.ok{color:var(--ok,#4dff9c);border-color:var(--ok,#4dff9c)}
html body .lrow{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}
html body .lrow b{overflow-wrap:anywhere;text-align:right}html body .lrow b.ok{color:var(--ok,#4dff9c)}html body .lrow b.bad{color:var(--bad)}html body .lrow b.warn{color:var(--yl,#ffd400)}
html body .lnote{margin-top:10px;font-size:12px}
html body .sgrp{margin:14px 0 6px;font:700 11px/1 var(--disp);letter-spacing:.2em;text-transform:uppercase;color:var(--mg)}
html body .sgrp:first-child{margin-top:0}
html body .sfld{display:grid;grid-template-columns:minmax(150px,210px) minmax(0,1fr);gap:2px 14px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(60,80,140,.18)}
html body .sfld>label{color:var(--txt);font-size:13px}
html body .sfld.wide{align-items:start}
html body .sfld input[type=text],html body .sfld select,html body .sfld textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:var(--r);padding:6px 9px;font:inherit}
html body .sfld textarea{resize:vertical;min-height:80px}
html body .sfld .dirty{border-color:var(--yl,#ffd400);box-shadow:0 0 0 1px var(--yl,#ffd400) inset}
html body .sfld .shint{grid-column:2;font-size:11.5px;line-height:1.4}
html body .sfld .shint.ok{color:var(--ok,#4dff9c)}html body .sfld .shint.bad{color:var(--bad)}
html body .sfld>label.chk{grid-column:2;grid-row:1;justify-self:start}
html body .sfld>input[type=checkbox]{grid-column:1;grid-row:1;justify-self:end;width:18px;height:18px}
html body .sfail{color:var(--bad);margin-bottom:6px}
html body .codebar{margin:8px 0 4px;padding:8px 10px;border:1px dashed var(--line);border-radius:var(--r);font-size:12px}
html body .cbrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
html body .cbcol{width:24px;height:24px;border:1px solid rgba(255,255,255,.35);border-radius:6px;padding:0;cursor:pointer}
html body .cbsty{min-width:30px;padding:2px 8px;font-weight:700}
html body .setgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;align-items:start;margin:12px 14px 0}
html body .setgrid>section{height:auto;min-height:0;overflow:visible}
html body .setgrid>section>.pad{overflow:visible;max-height:none;flex:none}
html body .setbar{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin:14px 14px 0;padding:10px 14px;background:linear-gradient(180deg,rgba(5,8,18,.2),var(--bg) 40%);border-top:1px solid var(--line)}
html body .setbar .dim{margin-right:auto;overflow-wrap:anywhere}html body .setbar #setmsg,html body .setbar #srvmsg{margin-right:0}
html body .abtop{display:flex;gap:14px;align-items:center;margin-bottom:10px}
html body .ablogo{width:56px;height:56px;border-radius:50%}
html body .abname{font:700 17px/1.2 var(--disp);letter-spacing:.06em}
html body .abtxt{margin-bottom:12px;color:var(--txt)}
html body .abrow{display:flex;gap:8px;flex-wrap:wrap}
html body .abbtn{display:inline-block;padding:6px 12px;border:1px solid var(--cy);border-radius:var(--r);color:var(--cy);text-decoration:none;font:inherit;background:transparent;cursor:pointer}
html body .abbtn.go{background:rgba(47,168,255,.14)}html body .abbtn:hover{background:var(--cy);color:#001018}
html body .navad{display:block;margin:8px 12px;padding:8px 10px;border:1px solid var(--line);border-left:3px solid var(--mg);border-radius:var(--r);text-decoration:none;color:var(--txt);line-height:1.3}
html body .navad b{display:block;font:700 10.5px/1.2 var(--disp);letter-spacing:.18em;color:var(--mg)}
html body .navad span{font-size:11.5px;color:var(--cy)}
html body .navad:hover{border-color:var(--cy);box-shadow:0 0 14px rgba(47,168,255,.35)}
@media (max-width:1100px){html body .srvg{grid-template-columns:minmax(0,1fr);grid-template-areas:"prev" "live" "form"}}
@media (max-width:620px){html body .sfld{grid-template-columns:minmax(0,1fr)}html body .sfld .shint{grid-column:1}html body .sfld>input[type=checkbox]{justify-self:start}html body .sfld>label.chk{grid-column:1;grid-row:auto}}
html body .nav{overflow-y:auto;overflow-x:hidden}
html body .nav>*{flex-shrink:0}
html body .page[data-page=server].on,html body .page[data-page=settings].on{padding-bottom:12px}
@media (max-width:1500px){html body h1{letter-spacing:.12em;font-size:15px}}
@media (min-width:701px) and (max-height:820px){html body .nav>button{padding-top:6px;padding-bottom:6px}html body .navad{margin:4px 12px;padding:5px 8px}}
html body .updhow{margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--yl,#ffd400);border-radius:var(--r);font-size:13px;line-height:1.45}
html body .updhow b{color:var(--yl,#ffd400)}\nhtml body .updhow a{color:var(--cy)}
html body .updhow .updpath{margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--cy);overflow-wrap:anywhere}
html body #updhist .bk{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
html body #updhist .bk button{margin-left:auto;white-space:nowrap;flex:none}
.crinfo{margin:0 0 10px}.crbox{display:flex;flex-direction:column;gap:12px}
html body .page[data-page=crashes].on{overflow-y:auto;display:block}html body #crbox{display:flex;flex-direction:column;gap:12px;padding-bottom:16px}
.crtools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}.crtools select{min-width:240px}
.crev{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.crhint{margin:8px 0;padding:8px 12px;border-left:3px solid var(--cy);background:rgba(0,195,255,.06)}
.crwarn{margin:8px 0;padding:8px 12px;border-left:3px solid var(--warn);background:rgba(255,212,0,.06)}
.crsigs{margin-top:8px}.crsig{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
.crsig .crn{min-width:46px;font-weight:700}.crsig .crl{min-width:52px;font-size:11px;letter-spacing:.1em;font-weight:700}
.crsig.fatal .crl,.crsig.error .crl{color:var(--bad)}.crsig.warn .crl{color:var(--warn)}
.crm{flex:1;min-width:0}.crs{word-break:break-word}
pre.crmore,pre.crtail{margin:6px 0;padding:8px;background:rgba(0,0,0,.35);border:1px solid var(--line);font:11.5px/1.45 var(--mono,monospace);white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
details summary{cursor:pointer;margin-top:10px;color:var(--cy)}
.perfrow{display:block;margin-top:8px}.perfrow select{margin-left:6px;padding:2px 6px}#perfnote{display:block;margin-top:4px;font-size:10.5px}
html body #bEmerg,html body #vpill,html body #bVpsStart,html body #bVpsStop,html body #bVpsEmerg{display:none!important}
html body .litehide,html body .bklist{display:none!important}
html body .prhero{margin:12px 14px 0;padding:16px 18px;border:1px solid var(--line);border-left:3px solid var(--yl,#ffd400);border-radius:var(--r);background:linear-gradient(90deg,rgba(255,212,0,.07),transparent)}
html body .prh1{font:700 26px/1.2 var(--disp);color:var(--yl,#ffd400);letter-spacing:.04em}
html body .prh2{font:600 17px/1.3 var(--disp);color:var(--cy);margin-top:6px}
html body .prh3{font-size:15px;color:var(--txt);margin-top:4px}
html body #watchsec,html body #selfsec,html body #pgsec,html body #bUpdAuto,html body #bUpdAll,html body #updAllNote,html body #hc_updates{display:none!important}
html body .litetag{font:700 10px/1 var(--disp);letter-spacing:.2em;font-style:normal;color:#0a0a12;background:var(--yl,#ffd400);padding:3px 6px;margin-left:6px;vertical-align:middle;-webkit-text-fill-color:#0a0a12;text-shadow:none}
html body .nav button.locked{opacity:.62}html body .nav button.locked:hover{opacity:1}
html body .nbpro{display:inline-block;margin-left:auto;background:transparent;border:1px solid var(--mg);color:var(--mg);font-size:9px;padding:1px 5px;letter-spacing:.12em}
html body .nbfull{display:inline-block;margin-left:auto;background:var(--yl,#ffd400);color:#0a0a12;font-weight:700;padding:1px 6px}
html body .nav button.getfull{color:var(--yl,#ffd400)}
html body .page[data-page=pro].on{overflow-y:auto;display:block;padding-bottom:12px}
html body .prbig{font:700 40px/1.1 var(--disp);color:var(--yl,#ffd400);margin-bottom:8px}
html body .prtxt{margin:0 0 12px;line-height:1.5;overflow-wrap:anywhere}
html body .prlist{margin:0;padding-left:18px;line-height:1.5}html body .prlist li{margin-bottom:8px}html body .prlist b{color:var(--cy)}
html body .prprice{font-weight:700;color:var(--yl,#ffd400);border-color:var(--yl,#ffd400)}
</style></head>
<body>
<header>
 <div class="brand"><img class="logo rnd" alt="VNR Network" src="data:image/png;base64,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"><div class="bt"><h1><b>VNR</b> CyberPunk Server Panel <i class="litetag">LITE</i></h1><span class="dim" id="sub">...</span></div></div>
 <span id="pill" class="pill offline"><span class="dot"></span><span id="pilltxt">CONNECTING</span></span>
 <span id="uptime" class="dim"></span>
 <button id="bWatch" class="warnbtn" hidden title="Open Updates"></button>
 <span class="sp"></span>
 <button id="bWho" class="who" type="button" title="Your name in the command log - click to change it">&#9673; <span id="whoTxt">operator</span></button>
 <button id="bEmerg" class="emerg" type="button" title="EMERGENCY STOP - kills the server on this PC immediately, no questions asked">&#9888; Emergency stop</button>
 <button id="bStart" class="go" title="Start the server">Start server</button>
 <button id="bStop" class="stop" title="Stop the server on this PC">Stop</button>
 <button id="bRestart" title="Restart the server on this PC">Restart</button>
 <span id="vpill" class="pill unknown" title="The server on the VPS"><span class="dot"></span><span id="vpilltxt">VPS</span></span>
 <button id="bVpsStart" class="go" title="Start the server on the VPS">Start VPS</button>
 <button id="bVpsStop" class="stop" title="Stop the server on the VPS (Ctrl+C first, then forced)">Stop VPS</button>
 <button id="bVpsEmerg" class="emerg" type="button" title="EMERGENCY STOP on the VPS - kills the server there immediately, no questions asked">&#9888; Emergency VPS</button>
</header>
<div id="gbar" aria-hidden="true"><i></i></div>
<div id="offbar" role="alert" hidden>Lost the connection to the launcher - reconnecting ...</div>
<div class="shell">
<nav class="nav" id="nav" aria-label="Sections">
 <div class="navhead">Control</div>
 <button data-page="dash" class="on"><i>&#9632;</i>Dashboard</button>
 <button data-page="server"><i>&#9670;</i>Server</button>
 <button data-page="console"><i>&#9654;</i>Console</button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>Monitor<span class="nbadge nbpro">PRO</span></button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>VPS<span class="nbadge nbpro">PRO</span></button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>Command log<span class="nbadge nbpro">PRO</span></button>
 <div class="navhead">Maintain</div>
 <button data-page="backups"><i>&#9707;</i>Backups</button>
 <button data-page="updates"><i>&#8679;</i>Updates<span class="nbadge" id="nbUpd" hidden></span></button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>Resources<span class="nbadge nbpro">PRO</span></button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>Mods<span class="nbadge nbpro">PRO</span></button>
 <button data-page="pro" data-lock="1" class="locked"><i>&#128274;</i>Crashes<span class="nbadge nbpro">PRO</span></button>
 <div class="navhead">Panel</div>
 <button data-page="pro" class="getfull"><i>&#9733;</i>Get full VNR<span class="nbadge nbfull">40&euro;</span></button>
 <button data-page="settings"><i>&#9881;</i>Settings</button>
 <a class="navad" href="https://vnrnetwork.online" target="_blank" rel="noopener" title="VNR Network Online - launchers, scripts and servers for Cyberpunk 2077"><b>VNR NETWORK ONLINE</b><span>vnrnetwork.online &#8599;</span></a>
 <div class="navdock" id="navdock" aria-label="Activity">
  <div class="dockhead"><span>Activity</span><span class="dockcount" id="dockcount"></span><button id="bStopAll" class="dockstop" type="button" hidden>&#9632; Stop all</button><button id="bClearNotes" class="dockclr" type="button" hidden>Clear</button></div>
  <div class="dockbody">
   <div id="prog" aria-live="polite" aria-label="Running operations"></div>
   <div id="toast" role="status" aria-live="polite" aria-label="Notifications"></div>
   <div class="dockempty" id="dockempty">Nothing running. Progress bars and notifications appear here.</div>
  </div>
 </div>
 <div class="navfoot dim" id="navfoot"><span id="navdir"></span><label class="perfrow" title="Light mode polls less often and caches file scans - for slow or shared CPUs such as a VPS">Speed <select id="perfsel" aria-label="Launcher speed"><option value="auto">Auto</option><option value="normal">Normal</option><option value="light">Light</option></select></label><span id="perfnote"></span></div>
</nav>
<main>
 <div class="page cx on" data-page="dash">
 <div class="ph2"><div><h2 class="pt">Dashboard</h2><div class="pd">Live state of the game server on this PC: services, what needs attention, backups and the latest changes.</div></div><div class="chips2" id="hc_dash"></div></div>
 <div class="tiles" id="tiles"></div>
 <div class="cxg dashg">
  <section class="attn" id="attnsec"><h2>Needs attention <span class="dim" id="attncount"></span></h2><div class="pad" id="attn"></div></section>
  <section class="actsec"><h2>Actions</h2><div class="pad" id="actions"></div></section>
  <section class="stsec"><h2>Status</h2><div class="pad"><div class="kv" id="status"></div></div></section>
  <section class="autosec"><h2>Automation</h2><div class="pad" id="auto"></div></section>
  <section class="recsec"><h2>Recent changes <button id="bAllChg" style="margin-left:auto;padding:2px 10px;font-size:12px">Full log</button></h2><div class="pad recent" id="recent"><div class="dim">Nothing yet.</div></div></section>
 </div>
 </div>
 <div class="page cx console" data-page="console">
 <div class="ph2"><div><h2 class="pt">Console</h2><div class="pd">The server log as it prints, the output of the actions you run, and the launcher change log.</div></div><div class="chips2" id="hc_console"></div></div>
  <section>
  <div class="tabs">
   <button class="tab on" data-tab="log">Server log</button>
   <button class="tab" data-tab="act">Action output</button>
   <button class="tab" data-tab="chg">Change log</button>
   <div class="tools" id="logtools">
    <button class="chip on" data-lv="all">All</button><button class="chip" data-lv="warn">Warnings</button><button class="chip" data-lv="error">Errors</button>
    <input type="text" id="find" placeholder="search" size="12" aria-label="Search log">
    <label class="dim"><input type="checkbox" id="follow" checked> follow</label>
    <button id="bClear">Clear view</button><button id="bCopy">Copy</button>
   </div>
  </div>
  <div id="log" tabindex="0" aria-live="off"></div>
  <div id="act" tabindex="0" hidden></div>
  <div id="chg" tabindex="0" hidden></div>
 </section>
 </div>
 <div class="page cx vwiz" data-page="vps">
 <div class="ph2"><div><h2 class="pt">VPS</h2><div class="pd">Press the button and the launcher does the rest. Anything it cannot do from here it tells you, step by step.</div></div><div class="chips2" id="hc_vps"></div></div>
 <section class="vauto" id="vauto" aria-live="polite">
  <div class="vhero">
   <div class="vheroText"><h3 id="vaTitle">Set up my VPS</h3><p id="vaSub">One button. It builds the installer, connects, trusts the VPS, sends the server files, creates and checks the database, starts the server and proves it works.</p></div>
   <div class="vheroBtns"><button class="go big" id="vaGo" type="button">Set up my VPS</button><button class="go big" id="vaRepair" type="button" title="Re-sends the scripts and changed files, repairs the database and the server, and checks everything. Needs the VPS to be set up once.">Repair my VPS</button><button id="vaCancel" type="button" hidden>Cancel</button><label class="vopt"><input type="checkbox" id="vaDb" checked><span>Include my database</span></label></div>
  </div>
  <div class="vaNeed" id="vaNeed" hidden></div>
  <ol class="vaPhases" id="vaPhases"></ol>
  <div class="vaSummary" id="vaSummary" hidden></div>
 </section>
 <section class="vhealth"><h2>VPS health <span class="dim" id="vaChkWhen"></span></h2><div class="pad" id="vaChecks"><div class="dim">The health report appears here after the setup has run. It covers the connection, the system, the database, the network and the server itself.</div></div></section>
 <section class="vserver"><h2>Server on the VPS</h2><div class="pad"><div class="tiles" id="vatiles"></div>
  <div class="vrow"><button id="vaStart" class="go" type="button">Start</button><button id="vaStop" class="stop" type="button">Stop</button><button id="vaRestart" type="button">Restart</button><button id="vaRefresh" type="button">Refresh</button></div></div></section>
 <section class="vgit"><h2>GitHub <span class="dim" id="ghWhen"></span></h2><div class="pad">
  <p class="vgitIntro">Your server lives in a private GitHub repository. Publish sends this PC's server there; Update pulls it onto the VPS. Secrets, logs and player data never leave their machine.</p>
  <div class="ghrepo"><label for="ghRepo">Repository</label><input id="ghRepo" type="text" placeholder="owner/name or https://github.com/owner/name" spellcheck="false" autocomplete="off"><button id="ghSave" type="button">Save</button></div>
  <div class="ghcols">
   <div class="ghbox"><h4>This PC</h4><div id="ghPc" class="ghlines"></div><div class="vrow"><button id="ghPublish" class="go" type="button">Publish to GitHub</button><button id="ghDown" type="button">Download from GitHub</button></div></div>
   <div class="ghbox"><h4>The VPS</h4><div id="ghVps" class="ghlines"></div>
    <div class="vrow"><button id="ghSetup" type="button">Set up GitHub on the VPS</button><button id="ghCheck" type="button">Check access</button><button id="ghUpdate" class="go" type="button">Update VPS from GitHub</button></div></div>
  </div>
  <div class="ghkey" id="ghKeyBox" hidden><h4>Add this key to the repository (once)</h4>
   <ol><li>Open <a id="ghKeyLink" href="#" target="_blank" rel="noopener">the repository's Deploy keys page</a> (opens GitHub).</li><li>Title: <b>ChoomVille VPS</b>. Paste the key below. Leave "Allow write access" OFF.</li><li>Press Add key, then come back and press <b>Check access</b>.</li></ol>
   <textarea id="ghKey" readonly rows="3"></textarea><div class="vrow"><button id="ghKeyCopy" type="button">Copy key</button></div></div>
  <div class="vrow ghall"><button id="ghAll" class="go" type="button">Publish and update the VPS</button><span class="dim">one press: upload from this PC, then install on the VPS</span></div>
 </div></section>
 <div class="vsteps" hidden>
  <article class="vstep" id="vs1" data-state="todo">
   <header><span class="vnum">1</span><div class="vtt"><h3>Prepare</h3><span>on this PC</span></div><span class="vbadge" id="vb1">TO DO</span></header>
   <div class="vbody"><p id="vt1">Makes the folder you copy to the VPS: setup scripts, your SSH key, the game tables and <b>a fresh export of your database</b>. No password or licence key goes in it.</p>
    <label class="vopt"><input type="checkbox" id="vWithDb" checked><span>Include my database</span></label></div>
   <footer><button class="go big" id="vPrepare">Prepare pack</button><button id="vOpenPack">Open folder</button><button id="vCopyPath">Copy path</button></footer>
  </article>
  <article class="vstep" id="vs2" data-state="locked">
   <header><span class="vnum">2</span><div class="vtt"><h3>Install</h3><span>on the VPS</span></div><span class="vbadge" id="vb2">LOCKED</span></header>
   <div class="vbody"><ol class="vlist"><li>Copy the pack folder to the VPS over RDP.</li><li>Double-click <b>Run_VPS_Setup.bat</b> there.</li><li>Nothing to type: the licence key travels in the pack (put it in <b>vps.licence.txt</b>). It asks for the MariaDB root password only if you installed MariaDB by hand.</li></ol>
    <p class="dim" id="vt2">It installs MariaDB and everything else, loads your database, and copies the host fingerprint to the clipboard. This page notices when the VPS answers.</p></div>
   <footer><span class="vlive" id="vlive2"><i></i><span>waiting for the VPS</span></span><button id="vRecheck">Check now</button></footer>
  </article>
  <article class="vstep" id="vs3" data-state="locked">
   <header><span class="vnum">3</span><div class="vtt"><h3>Go live</h3><span>from this PC</span></div><span class="vbadge" id="vb3">LOCKED</span></header>
   <div class="vbody"><div id="vfpwrap"><div class="dim" style="font-size:12px">Host fingerprint from the VPS (already on your clipboard):</div>
     <div class="vfprow"><input type="text" id="vfpmain" autocomplete="off" placeholder="SHA256:... (or just press Finish)"><button id="vPaste">Paste</button></div></div>
    <div id="vfin" class="vfin"></div></div>
   <footer><button class="go big" id="vFinish">Finish install</button><button class="go" id="vGo">Start server</button><button class="stop" id="vStopMain">Stop</button></footer>
  </article>
 </div>
 <details class="vadv" id="vadv"><summary>Advanced tools <span class="dim">output, server log, send files, settings, manual steps</span></summary>
 <section class="vpanel">
  <div class="vtabs"><button class="vtab on" data-t="status">Status</button><button class="vtab" data-t="checks">Checklist <span class="dim" id="vchkwhen"></span></button><button class="vtab" data-t="out">Output</button><button class="vtab" data-t="log">Server log</button><button class="vtab" data-t="files">Send files</button><button class="vtab" data-t="set">Settings</button></div>
  <div class="vpane on" data-t="status">
   <div class="tiles" id="vpstiles"></div>
   <div class="vrow"><button id="vStart" class="go">Start</button><button id="vStop" class="stop">Stop</button><button id="vRestart">Restart</button><button id="vRefresh">Refresh</button><button id="vCheck">Check VPS</button><button id="vCfg">Check server.jsonc</button><button id="vDb">Database tables</button></div>
   <div class="dim" style="font-size:12px;margin-top:8px">Stop asks the server to shut down with Ctrl+C first and only forces it if that does not work.</div>
  </div>
  <div class="vpane" data-t="checks"><div class="pad" id="vpschecks"><div class="dim">Press "Finish install" or "Check VPS".</div></div></div>
  <div class="vpane" data-t="out"><div id="vpsout" class="mono" tabindex="0"></div></div>
  <div class="vpane" data-t="log"><label class="dim vlivechk"><input type="checkbox" id="vLive"> live</label><div id="vlog" class="mono" tabindex="0"></div></div>
  <div class="vpane" data-t="files"><div class="pad">
   <div id="vgroups"></div>
   <div class="vrow"><button id="vPlan">Compare</button><button id="vSend" class="go" disabled>Send changed files</button></div>
   <div id="vplan" class="dim" style="margin-top:6px"></div>
   <div class="dim" style="font-size:12px;margin-top:6px">Only files whose content differs are sent. Old copies are backed up on the VPS first, every file is verified by sha256, nothing is deleted. Secrets, .open77, logs and backups are never sent.</div></div></div>
  <div class="vpane" data-t="set"><div class="pad">
   <div class="kv" id="vpskv"></div>
   <div class="vform" id="vpsform">
    <label>VPS address<input type="text" id="vf_host" autocomplete="off"></label>
    <label>Windows user on the VPS<input type="text" id="vf_user" autocomplete="off" placeholder="e.g. Administrator"></label>
    <label>SSH port<input type="text" id="vf_port" autocomplete="off"></label>
    <label>Server folder on the VPS<input type="text" id="vf_root" autocomplete="off"></label>
    <label>Address players use<input type="text" id="vf_pub" autocomplete="off"></label>
    <label>Private key file (blank = default)<input type="text" id="vf_key" autocomplete="off"></label>
   </div>
   <div class="vrow"><button id="vSave" class="go">Save</button><button id="vKey">Show SSH public key</button><button id="vTrust">Trust host key (manual)</button><button id="vForget">Forget host key</button><button id="vPack">Rebuild pack without database</button><button id="vScripts">Update VPS scripts</button></div>
   <div id="vkeybox" hidden><div class="dim">Public key (safe to share; it only lets this launcher in):</div><textarea id="vkeytxt" readonly rows="3"></textarea><button id="vKeyCopy">Copy</button></div>
   <div id="vtrustbox" hidden>
     <div class="dim">The VPS says its host key fingerprint is:</div><div class="mono" id="vfp"></div>
     <div class="dim">Compare it with the line the setup printed on the VPS, then type or paste it here:</div>
     <input type="text" id="vfpin" autocomplete="off" placeholder="SHA256:..."><div class="vrow"><button id="vTrustGo" class="go">Trust it</button><button id="vTrustNo">Cancel</button></div>
   </div>
   <div class="dim" id="vpsconn" style="margin-top:8px"></div>
  </div></div>
 </section></details>
 </div>
 <div class="page cx" data-page="backups"><div class="ph2"><div><h2 class="pt">Backups</h2><div class="pd">Full backups of your server files that you can restore from.</div></div><div class="chips2" id="hc_backups"></div></div>
 <div class="cxg bkg">
  <section class="bkdo"><h2>Make a backup</h2><div class="pad">
    <div class="bkbtns litehide"><button id="bBkAll" class="go">Back up now</button><button id="bBkDb">Database</button><button id="bBkCfg">Config</button><button id="bBkScr">Scripts</button></div>
    <div class="bkfull"><button id="bBkFull" class="go" title="Copies every file the server needs and checks each copy">Full backup</button><span class="dim">every server file, checked - made automatically before an update. Database, config-only and verify backups are in the full VNR.</span></div>
    <div class="bsum" id="bksum"></div>
    <div class="dim bkwhere" id="bkwhere"></div></div></section>
  <section class="bklist"><h2>Backups</h2><div class="pad"><div id="bklist"></div></div></section>
  <section class="bkfulls"><h2>Full backups <span class="dim">restore</span></h2><div class="pad"><div id="fulllist"></div></div></section>
 </div></div>
 <div class="page cx" data-page="updates"><div class="ph2"><div><h2 class="pt">Updates</h2><div class="pd">Update packs found in the updates folder, and alerts when newer releases exist upstream.</div></div><div class="chips2" id="hc_updates"></div></div>
 <div class="cxg updg">
  <section><h2>Updates</h2><div class="pad"><div class="updhow" id="updhow"></div><div class="updall" id="updAll"><button id="bUpdAuto" class="go" type="button">Update everything now</button><button id="bUpdAll" type="button">Only download</button><button id="bUpdLog" type="button">Open update log</button><span class="dim" id="updAllNote"></span></div><div id="updlist"></div>
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><button id="bUpdRefresh">Refresh</button></div>
    <div class="dim" style="font-size:12px;margin-top:6px" id="updwhere"></div><div id="updhist" style="margin-top:10px"></div></div></section>
  <section id="watchsec"><h2>Update alerts <span class="dim" id="watchwhen"></span></h2><div class="pad"><div id="watchlist"></div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center"><button id="bWatchCheck" class="go">Check now</button><label class="dim"><input type="checkbox" id="watchOn"> check every</label><input type="text" id="watchHrs" size="2" style="width:44px" aria-label="Hours between checks"><span class="dim">hours</span></div>
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input type="text" id="watchRepo" placeholder="owner/repo" style="flex:1;min-width:120px" aria-label="GitHub repository"><input type="text" id="watchLabel" placeholder="name (optional)" style="width:130px" aria-label="Name"><button id="bWatchAdd">Watch</button></div>
    <div class="dim" style="font-size:12px;margin-top:6px">Watches the Open77 server, the launcher, GitHub repos you add, and git clones found next to the server. Private repos: put GITHUB_TOKEN in ChoomVille_Secrets.cmd.</div></div></section>
  <section id="selfsec"><h2>Launcher updates (GitHub) <span class="dim" id="selfwhen"></span></h2><div class="pad"><div id="selfstate"></div>
   <div class="selfin"><input type="text" id="selfRepo" placeholder="owner/repo  (for example L0G1C4LP5YCH0/vnr-launcher)" aria-label="Launcher repository"><input type="text" id="selfBranch" placeholder="main" size="7" aria-label="Branch"><button id="bSelfSave" type="button">Connect</button></div>
   <div class="selfbtns"><button id="bSelfCheck" type="button">Check now</button><button id="bSelfInstall" class="go" type="button" hidden>Update launcher</button><button id="bSelfPublish" type="button" hidden>Publish this version</button><button id="bSelfCreate" class="go" type="button" hidden>Create repository and publish</button><button id="bSelfRoll" type="button" hidden>Roll back</button><button id="bSelfRestart" type="button">Restart launcher</button></div>
   <div class="selfzip"><div class="selfziph">Update from a zip</div><div class="dim selfzipt" id="selfzipt"></div>
    <div class="selfbtns"><button id="bSelfZipOpen" type="button">Open zip folder</button><button id="bSelfZip" class="go" type="button">Update from zip</button></div></div>
   <div class="dim selfhelp" id="selfhelp"></div></div></section>
  <section id="pgsec"><h2>Patch guard <span class="dim" id="pgwhen"></span></h2><div class="pad"><div id="pgsum" class="pgsum"></div>
   <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button id="bPgSave" class="go">Save patched files now</button><button id="bPgApply">Check / re-apply</button><button id="bPgList">List files</button></div>
   <div class="dim" style="font-size:12px;margin-top:6px">Keeps a copy of every file we changed outside resources/choomville, plus the original it came from. An update saves them first, then puts them back or merges them with the new release. Anything it cannot merge safely is listed in What changed.</div></div></section>
 </div></div>
<div class="page mon" data-page="monitor">
 <div class="ph2"><div><h2 class="pt">Monitor</h2><div class="pd">Live CPU, memory, players, tick time and the cost of each Lua resource. Every number is measured; a dash means that source is not available.</div></div><div class="chips2"><div class="rng" id="monrng" role="group" aria-label="Time range"><button data-r="300">5 min</button><button data-r="900" class="on">15 min</button><button data-r="3600">1 hour</button></div><div class="chips2" id="hc_monitor"></div></div></div>
 <div id="monbanner" class="monbanner" hidden></div>
 <div class="tiles" id="montiles"></div>
 <div class="mongrid">
  <div class="mcard"><div class="mh"><b>Server CPU</b><span class="dim" id="mh_cpu"></span></div><canvas id="cCpu"></canvas></div>
  <div class="mcard"><div class="mh"><b>Server memory</b><span class="dim" id="mh_mem"></span></div><canvas id="cMem"></canvas></div>
  <div class="mcard"><div class="mh"><b>Players</b><span class="dim" id="mh_ply"></span></div><canvas id="cPly"></canvas></div>
  <div class="mcard"><div class="mh"><b>Tick time</b><span class="dim" id="mh_tick"></span></div><canvas id="cTick"></canvas></div>
  <div class="mcard mres"><div class="mh"><b>Lua resources</b><span class="dim" id="mh_res"></span><select id="monsort" aria-label="Sort resources by"><option value="sched">by scheduler time</option><option value="ev">by event time</option><option value="mem">by memory</option><option value="calls">by calls/s</option><option value="fail">by failures</option></select></div>
   <div id="restab"></div><div class="mh" style="margin-top:6px"><b id="resname">-</b><span class="dim" id="resnote"></span></div><canvas id="cRes"></canvas><canvas id="cResMem"></canvas></div>
 </div>
</div>
 <div class="page cx" data-page="crashes"><div class="ph2"><div><h2 class="pt">Crashes</h2><div class="pd">Reads the server log: how each run ended, the errors grouped, what to look at first.</div></div><div class="chips2" id="hc_crashes"></div></div>
 <div class="crtools"><select id="crsel" aria-label="Which log"></select><button id="bCrRefresh" type="button">Refresh</button><button id="bCrCopy" type="button">Copy report</button><button id="bCrSave" type="button">Save log now</button><button id="bCrOpen" type="button">Open saved logs</button></div>
 <div id="crbox"></div></div>
 <div class="page cx" data-page="mods"><div class="ph2"><div><h2 class="pt">Mods</h2><div class="pd">The mods players must have to join this server, and the server name.</div></div><div class="chips2" id="hc_mods"></div></div>
 <div class="modgrid" id="modsbox"></div></div>
 <div class="page cx" data-page="resources"><div class="ph2"><div><h2 class="pt">Resources</h2><div class="pd">Everything the server loads on boot, grouped into custom scripts and the Open77 platform.</div></div><div class="chips2" id="hc_resources"></div></div>
 <div class="cxg resg">
  <section class="reslistsec"><h2>Resources loaded on boot <span class="dim" id="rescount"></span></h2>
   <div class="rtools"><input type="text" id="resfind" placeholder="filter by name or folder" aria-label="Filter resources" autocomplete="off"><span id="reschips" style="display:flex;gap:6px;flex-wrap:wrap"></span><button id="resfold" title="Open or close every group">Collapse all</button></div>
   <div id="reslist"></div></section>
  <section class="resaddsec"><h2>Add to the load list</h2><div class="pad">
   <div class="radd"><select id="resadd" aria-label="Resource to add"></select><button id="bAdd" class="go">Add to load list</button></div>
   <div class="dim resnote">Changes edit server.jsonc (a backup is kept first) and need a server restart. The number on the left is the place in the load order; the arrows move a resource one place in that order. Groups are decided by folder: choomville/ = custom, system/ = Open77 platform.</div></div></section>
 </div></div>
 <div class="page cx" data-page="server"><div class="ph2"><div><h2 class="pt">Server</h2><div class="pd">Your server's public details. Change them here and save: a backup of the config is kept first, and players see the changes after the server restarts.</div></div><div class="chips2" id="hc_server"></div></div>
 <div class="srvg">
  <section class="srvprev"><h2>How it looks</h2><div class="pad"><div id="spName" class="spname"></div><div id="spDesc" class="spdesc"></div><div id="spMeta" class="spmeta"></div></div></section>
  <section class="srvlivesec"><h2>Right now</h2><div class="pad" id="srvlive"></div></section>
  <section class="srvform"><h2>Details</h2><div class="pad"><div id="srvff"></div></div></section>
 </div>
 <div class="setbar"><span id="srvmsg" class="dim">No changes</span><button id="srvdiscard" disabled>Discard changes</button><button id="srvsave" class="go" disabled>Save details</button></div></div>
 <div class="page cx" data-page="settings"><div class="ph2"><div><h2 class="pt">Settings</h2><div class="pd">Point the panel at your server and tune how it behaves. Every change is backed up first.</div></div><div class="chips2" id="hc_settings"></div></div>
 <div class="setgrid">
  <section class="setabsec"><h2>About</h2><div class="pad" id="setabout"></div></section>
  <section><h2>Panel</h2><div class="pad"><div id="setlnf"></div><div id="setlnx"></div></div></section>
  <section><h2>Server files</h2><div class="pad" id="setsrvf"></div></section>
  <section><h2>Backups</h2><div class="pad" id="setbkf"></div></section>
 </div>
 <div class="setbar"><span id="setcfg" class="dim"></span><span id="setmsg" class="dim">No changes</span><button id="setdiscard" disabled>Discard changes</button><button id="setsave" class="go" disabled>Save settings</button></div></div>
 <div class="page cx" data-page="pro"><div class="ph2"><div><h2 class="pt">Get the full VNR</h2><div class="pd">You are using VNR - CyberPunk Server Panel Lite. The full version adds everything below. Backups in Lite are the full file backup only.</div></div><div class="chips2"><span class="pill prprice">40 &euro;</span></div></div>
 <section class="prhero"><div class="prh1">Update without fear.</div><div class="prh2">Your server stays up while you sleep.</div><div class="prh3">Run your server from one page, on your PC or your VPS.</div></section>
 <div class="setgrid">
  <section class="prbuy"><h2>Buy the full version</h2><div class="pad">
   <div class="prbig">40 &euro;</div>
   <p class="prtxt">Email <b>virtualnexusroads@gmail.com</b> to buy the full VNR - CyberPunk Server Panel. Tell us the name of your server and you will get the full version.</p>
   <div class="abrow"><a class="abbtn go" href="mailto:virtualnexusroads@gmail.com?subject=Buy%20the%20full%20VNR%20CyberPunk%20Server%20Panel">Email to buy</a><a class="abbtn" href="https://discord.com/invite/nRXxYY8mbk" target="_blank" rel="noopener">Join the VNR Discord</a><a class="abbtn" href="https://vnrnetwork.online" target="_blank" rel="noopener">vnrnetwork.online</a></div>
   <p class="prtxt dim">Questions first? Ask in the Discord or email the same address.</p></div></section>
  <section><h2>What the full version adds</h2><div class="pad"><ul class="prlist">
   <li><b>VPS control</b> - install and run your server on a VPS from the panel: start, stop, Emergency VPS, a live command box and VPS logs.</li>
   <li><b>Crash handling</b> - automatic restart after a crash (with a limit per hour), a Crashes page and saved copies of the server log.</li>
   <li><b>Daily restart</b> - restart the server on a schedule you choose.</li>
   <li><b>Complete backups</b> - database, config and script backups, scheduled backups, a backup before every restart, and backup verification.</li>
   <li><b>Automatic updates</b> - GitHub update sources for your packs, update alerts, background download and install, update reports and one-click rollback.</li>
   <li><b>Patched-file protection</b> - save your patched files and re-apply them after an update.</li>
   <li><b>Mods and Resources pages</b> - add, remove and reorder what your server loads.</li>
   <li><b>Monitor</b> - live performance graphs and lag tracking.</li>
   <li><b>Command log</b> - a full history of who did what and who started or stopped the server, with export.</li>
   <li><b>Emergency stop</b>, stop-all-jobs and attention alerts.</li>
   <li><b>Panel self-update</b> from GitHub, with publish and rollback.</li>
  </ul></div></section>
  <section class="prwhy"><h2>Why owners go full</h2><div class="pad"><ul class="prlist">
   <li>Every action is logged: you can see who started, stopped or changed anything.</li>
   <li>Emergency stop, one click, on the PC or the VPS.</li>
   <li>Every backup copy is checked, not just copied.</li>
   <li>Built for Open77 / Cyberpunk 2077 servers.</li>
  </ul></div></section>
 </div></div>
 <div class="page cx" data-page="cmdlog"><div class="ph2"><div><h2 class="pt">Command log</h2><div class="pd">Every command the launcher ran or was asked to run: who or what asked (a person at the dashboard, a script, or the launcher itself), exactly what was done, and how it ended. Click a row for the full details.</div></div><div class="chips2" id="hc_cmdlog"></div></div>
 <section class="clsec">
  <div class="cltools">
   <input type="text" id="clFind" placeholder="search commands, people, scripts, details ..." aria-label="Search the command log" autocomplete="off">
   <div class="seg" id="clWho" role="group" aria-label="Who"><button type="button" data-v="all" class="on">Everyone</button><button type="button" data-v="person">People</button><button type="button" data-v="script">Scripts</button><button type="button" data-v="system">System</button></div>
   <div class="seg" id="clKind" role="group" aria-label="What"><button type="button" data-v="all" class="on">All</button><button type="button" data-v="request">Requests</button><button type="button" data-v="process">Programs</button></div>
   <div class="seg" id="clSt" role="group" aria-label="Result"><button type="button" data-v="all" class="on">Any result</button><button type="button" data-v="running">Running</button><button type="button" data-v="failed">Failed</button><button type="button" data-v="stopped">Stopped</button></div>
   <label class="dim clive"><input type="checkbox" id="clLive" checked> live</label>
   <span class="sp"></span>
   <button type="button" id="clCsv" title="Download the whole log as a spreadsheet">Export CSV</button><button type="button" id="clJson" title="Download the whole log as JSON">Export JSON</button>
  </div>
  <div class="clhead"><span>Time</span><span>Who</span><span>What</span><span>Result</span></div>
  <div id="cllist" tabindex="0" aria-live="off"></div>
 </section>
</div>
</main>
</div>
<dialog id="wdlg"><div class="in"><h3>Who is using the launcher?</h3><div class="dim">Your name is written next to every command you run, in the command log. Leave it empty to use this PC's user name.</div>
 <input type="text" id="wname" maxlength="40" style="width:100%;margin-top:12px" autocomplete="off" placeholder="your name">
 <div class="row"><button id="wno" type="button">Cancel</button><button id="wyes" class="go" type="button">Save</button></div></div></dialog>
<dialog id="ndlg"><div class="in"><h3 style="color:var(--cy)">Rename the server</h3><div class="dim">This is the name shown in the launcher and in the server list.</div><input type="text" id="ninp" maxlength="100" autocomplete="off" aria-label="Server name"><div id="nerr" role="alert"></div><div class="row"><button id="nno" type="button">Cancel</button><button id="nyes" class="go" type="button">Save name</button></div></div></dialog>
<dialog id="dlg"><div class="in"><h3 id="dtitle">Are you sure?</h3><div id="dbody"></div>
 <input type="text" id="dtype" style="width:100%;margin-top:12px;display:none" autocomplete="off">
 <div class="row"><button id="dno">Cancel</button><button id="dyes" class="danger">Do it</button></div></div></dialog>
<dialog id="vcmd"><div class="in"><h3 id="vcmdT">VPS</h3><div id="vcmdSt" class="dim">running ...</div><div id="vcmdOut" class="mono" tabindex="0"></div>
 <div class="row"><button id="vcmdCopy">Copy output</button><button id="vcmdStop" class="stop">Stop</button><button id="vcmdX" class="go">Close</button></div></div></dialog>
<dialog id="bkdlg"><div class="in"><h3 style="color:var(--warn)">No recent backup</h3><div id="bktxt"></div><div class="dim" style="margin-top:10px">Nothing is backed up unless you choose it. Your choice is logged.</div><div class="row"><button id="bkno" type="button">Cancel</button><button id="bkskip" class="danger" type="button">Update without a backup</button><button id="bkyes" class="go" type="button">Back up first, then update</button></div></div></dialog>
<dialog id="udlg"><div class="in"><h3 id="utitle">Update</h3><div id="ubody"></div><div id="ulist"></div>
 <div class="dim" id="ubk" style="margin-top:12px"></div>
 <label class="dim" id="ustartw" style="display:block;margin-top:10px"><input type="checkbox" id="ustart"> start the server afterwards</label>
 <div class="bad" id="uwhy" style="margin-top:12px;display:none"></div>
 <div class="row"><button id="uno">Cancel</button><button id="uyes" class="go">Apply update</button></div></div></dialog>
<dialog id="pdlg"><div class="in"><h3>Patched files</h3><div id="pdsum" class="dim"></div><div id="pdbody"></div>
 <div class="row"><button id="pdclose">Close</button></div></div></dialog>
<dialog id="rdlg"><div class="in"><h3 id="rtitle">What changed</h3><div id="rsum"></div><div id="rbody"></div>
 <div class="row"><button id="rcopy" class="go">Copy report for Claude</button><button id="rclose">Close</button></div></div></dialog>
<script>
(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var MODE='__VNR_MODE__';
var hdT=0,state=null, level='all', tab='log', lines=[], MAXV=2500;
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function toast(msg,kind){
  var t=el('div','t '+(kind||'')),m=el('div','tm',String(msg)),tt=el('div','tt',new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),x=el('button','tx','\u2715');
  x.type='button';x.title='dismiss';x.setAttribute('aria-label','dismiss this notification');x.onclick=function(){t.remove()};
  t.appendChild(m);t.appendChild(tt);t.appendChild(x);
  var box=$('#toast');box.insertBefore(t,box.firstChild);
  while(box.children.length>12)box.removeChild(box.lastChild);
  if(kind!=='bad'&&kind!=='warn')setTimeout(function(){t.remove()},30000);
}
(function(){
  var dock=$('#navdock');if(!dock||!window.MutationObserver)return;
  function upd(){var n=$('#prog').children.length,k=$('#toast').children.length;
    $('#dockcount').textContent=(n+k)?String(n+k):'';$('#dockempty').hidden=!!(n+k);$('#bClearNotes').hidden=!k}
  var mo=new MutationObserver(upd);mo.observe($('#prog'),{childList:true});mo.observe($('#toast'),{childList:true});upd();
  $('#bClearNotes').onclick=function(){var b=$('#toast');while(b.firstChild)b.removeChild(b.firstChild)};
})();
var WHO='';try{WHO=localStorage.getItem('vnrWho')||''}catch(e){}
var lastBtn=null,lastBtnT=0;
document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button'):null;if(b&&!b.disabled){lastBtn=b;lastBtnT=Date.now()}},true);
function api(path,body){
  var post=body!==undefined,h={'X-CV':'1','X-CV-Via':'ui','Content-Type':'application/json'};
  if(WHO)h['X-CV-Who']=encodeURIComponent(WHO);
  var bb=null;
  if(post&&lastBtn&&Date.now()-lastBtnT<600&&!lastBtn.closest('.nav,.tabs,.vtabs,.rng,.seg,.pi,.dockhead,.tx,dialog')){bb=lastBtn;lastBtn=null;bb.classList.add('busy');bb.setAttribute('aria-busy','true')}
  return fetch(path,{method:post?'POST':'GET',headers:h,body:post?JSON.stringify(body):undefined})
   .then(function(r){return r.json()}).catch(function(e){return {ok:false,error:'Dashboard is not reachable: '+e.message}})
   .then(function(r){if(bb){bb.classList.remove('busy');bb.removeAttribute('aria-busy')}return r});
}
function ts(t){var d=new Date(t);return d.toTimeString().slice(0,8)}
function addLine(e){
  lines.push(e);if(state&&!hdT)hdT=setTimeout(function(){hdT=0;heads()},400); if(lines.length>MAXV) lines.shift();
  if(visible(e)){var box=$('#log'); box.appendChild(row(e)); while(box.childNodes.length>MAXV) box.removeChild(box.firstChild); if($('#follow').checked) box.scrollTop=box.scrollHeight}
}
function row(e){var d=el('div','ln '+(e.s==='dash'?'dash':e.l));var s=el('span','ts',ts(e.t));d.appendChild(s);d.appendChild(document.createTextNode(e.m));return d}
function visible(e){
  if(e.s==='dash') return true;
  if(level==='warn'&&e.l==='info') return false;
  if(level==='error'&&e.l!=='error') return false;
  var q=$('#find').value.trim().toLowerCase(); if(q&&e.m.toLowerCase().indexOf(q)<0) return false;
  return true;
}
function redraw(){var box=$('#log');box.textContent='';var f=document.createDocumentFragment();lines.forEach(function(e){if(visible(e))f.appendChild(row(e))});box.appendChild(f);box.scrollTop=box.scrollHeight}
function fmtUp(iso){ if(!iso) return ''; var s=Math.max(0,(Date.now()-Date.parse(iso))/1000|0),h=s/3600|0,m=(s%3600)/60|0; return 'up '+(h?h+'h ':'')+m+'m '+(s%60)+'s'}
function dlg(title,body,typeWord,yes){
  return new Promise(function(res){
    $('#dtitle').textContent=title;$('#dbody').textContent=body;var t=$('#dtype');
    if(typeWord){t.style.display='';t.value='';t.placeholder='type '+typeWord+' to confirm'}else t.style.display='none';
    var d=$('#dlg');
    function done(v){d.close();$('#dyes').onclick=$('#dno').onclick=null;res(v)}
    $('#dyes').textContent=yes||'Do it';
    $('#dno').onclick=function(){done(null)};
    $('#dyes').onclick=function(){ if(typeWord&&t.value!==typeWord){t.focus();return} done(typeWord?t.value:true)};
    d.showModal(); (typeWord?t:$('#dno')).focus();
  });
}
/*HEADS*/
function cp(cls,label,val){var s=el('span','cp '+(cls||''));s.appendChild(document.createTextNode(label+' '));s.appendChild(el('b','',val));return s}
function relT(t){if(!t)return 'never';var m=Math.max(0,(Date.now()-t)/60000|0);if(m<1)return 'just now';if(m<60)return m+' min ago';var h=m/60|0;if(h<48)return h+' h ago';return (h/24|0)+' days ago'}
function setChips(id,arr){var b=$('#hc_'+id);if(!b)return;var sig=JSON.stringify(arr);if(b.dataset.sig===sig)return;b.dataset.sig=sig;b.textContent='';arr.forEach(function(a){b.appendChild(cp(a[0],a[1],a[2]))})}
function heads(){
  if(!state)return;var s=state.server.state;
  var lb=state.lastBackupAt,lbOk=lb&&Date.now()-lb<172800000;
  setChips('dash',[[s==='online'?'ok':s==='offline'?'bad':'warn','Server',s.toUpperCase()],[state.db.up?'ok':'bad','Database',state.db.up?'online':'down'],[lbOk?'ok':'warn','Last backup',relT(lb)],['info','Resources',String(state.resourcesCount)]]);
  var er=0,wr=0;lines.forEach(function(e){if(e.l==='error')er++;else if(e.l==='warn')wr++});
  setChips('console',[['info','Lines in view',String(lines.length)],[er?'bad':'ok','Errors',String(er)],[wr?'warn':'ok','Warnings',String(wr)]]);
  var v=state.vps;if(v){var vs=v.state||'unknown';setChips('vps',[[vs==='online'?'ok':vs==='offline'?'bad':'warn','VPS',vs.toUpperCase()],['info','Host',String(v.host||'-')],[v.keyExists?'ok':'warn','SSH key',v.keyExists?'created':'none'],[v.hostPinned?'ok':'warn','Host key',v.hostPinned?'trusted':'not trusted']])}
  var fb=state.fullBackups||[];
  setChips('backups',[[lbOk?'ok':'warn','Last backup',relT(lb)],[fb.length?'ok':'warn','Full backups',String(fb.length)],['info','Other backups',String(state.backups.length)]]);
  var n=state.watch?state.watch.count:0;
  setChips('updates',[[n?'warn':'ok','Upstream',n?n+' update'+(n>1?'s':'')+' available':'up to date'],['info','Packs',upd&&upd.packs?String(upd.packs.length):'-'],['info','Last check',state.watch&&state.watch.lastCheck?relT(Date.parse(state.watch.lastCheck)||state.watch.lastCheck):'never']]);
  if(resData)setChips('resources',[['info','In load list',String(resData.rows.length)],['info','More on disk',String(resData.available.length)]]);
  var it=(state.progress||[]).filter(function(x){return x.step>0}),dn=it.filter(function(x){return x.status==='done'}).length,ts2=it.filter(function(x){return x.status==='testing'}).length,dg=it.filter(function(x){return x.status==='doing'}).length;
  setChips('progress',[['ok','Done',dn+' / '+it.length],[ts2?'warn':'info','Testing',String(ts2)],['info','In progress',String(dg)],['info','To do',String(it.length-dn-ts2-dg)]]);
  attention();
}
function attention(){
  var box=$('#attn');if(!box)return;var L=[];
  var s=state.server.state;
  if(s==='offline')L.push(['warn','Game server is not running','Start it with Start locally in the header.']);
  if(s==='starting'||s==='stopping')L.push(['info','Game server is '+s,'Wait for it to finish.']);
  if(!state.db.up)L.push(['bad','Database is not reachable','MariaDB did not answer on port '+state.db.port+'. The server needs it to start.']);
  if(state.serverFolderOk===false)L.push(['bad','Server folder not found','The panel cannot find your server. Point it at the right folder.','settings','Open Settings']);
  var lb=state.lastBackupAt;
  if(!lb)L.push(['warn','No backup has been made yet','Open Backups and press Back up now.','backups','Open Backups']);
  else if(Date.now()-lb>=172800000)L.push(['warn','Last backup is '+relT(lb),'Older than 48 hours.','backups','Open Backups']);
  var n=state.watch?state.watch.count:0;
  if(n)L.push(['warn',n+' update'+(n>1?'s':'')+' available','See which on the Updates page.','updates','Open Updates']);
  var v=state.vps;if(v&&v.error)L.push(['warn','VPS: '+v.error,'','vps','Open VPS']);
  var sig=JSON.stringify(L);if(box.dataset.sig===sig)return;box.dataset.sig=sig;box.textContent='';
  $('#attncount').textContent=L.length?'('+L.length+')':'';
  if(!L.length){var d=el('div','ai ok');var tx=el('div','tx');tx.appendChild(el('b','','All clear'));tx.appendChild(el('span','','Server, database, backups and updates all look fine.'));d.appendChild(tx);box.appendChild(d);return}
  L.forEach(function(a){var d=el('div','ai '+(a[0]==='warn'?'':a[0]));var tx=el('div','tx');tx.appendChild(el('b','',a[1]));if(a[2])tx.appendChild(el('span','',a[2]));d.appendChild(tx);if(a[3]){var b=el('button','',a[4]);b.onclick=function(){showPage(a[3])};d.appendChild(b)}box.appendChild(d)})
}
function render(){
  if(!state) return;
  var s=state.server.state; var p=$('#pill'); p.className='pill '+s; $('#pilltxt').textContent=s.toUpperCase();
  $('#uptime').textContent=s==='online'?fmtUp(state.server.startedAt):'';drawBrand();
  $('#bStart').disabled=s!=='offline';$('#bStop').disabled=s!=='online';$('#bRestart').disabled=s!=='online';
  var st=$('#status');st.textContent='';
  function kv(k,v,c){st.appendChild(el('span','',k));st.appendChild(el('span',c||'',v))}
  kv('Game server',s==='online'?'running (PID '+state.server.pids.join(', ')+')':s, s==='online'?'ok':'bad');
  kv('Game port',state.ports.game?'UDP '+state.ports.game:'-');
  kv('Downloads',state.ports.download.up?'TCP '+state.ports.download.port+' open':'closed',state.ports.download.up?'ok':'dim');
  kv('Warden',state.ports.warden.up?'TCP '+state.ports.warden.port+' open':'closed',state.ports.warden.up?'ok':'dim');
  kv('Database',state.db.up?'MariaDB on '+state.db.port:'not reachable',state.db.up?'ok':'bad');
  kv('Resources',state.resourcesCount+' in load list');
  kv('Folder',state.serverDir,'dim');
  var a=$('#actions'); if(a.dataset.sig!==JSON.stringify(state.buttons)){
    a.dataset.sig=JSON.stringify(state.buttons);a.textContent='';
    var groups={};state.buttons.forEach(function(b){(groups[b.group]=groups[b.group]||[]).push(b)});
    Object.keys(groups).forEach(function(g){
      a.appendChild(el('div','grp',g));var w=el('div','btns');
      groups[g].forEach(function(b){var x=el('button',b.danger?'danger':'',b.label);if(b.hint)x.title=b.hint;x.onclick=function(){runBtn(b)};w.appendChild(x)});
      a.appendChild(w);
    });
    (state.links||[]).length&&a.appendChild(el('div','grp','Links'));
    var lw=el('div','btns');(state.links||[]).forEach(function(l){var x=el('button','',l.label+' ↗');x.onclick=function(){window.open(l.url,'_blank','noopener')};lw.appendChild(x)});a.appendChild(lw);
  }
  renderAuto();renderBackups();renderVps();
  renderProgress();recentDraw();heads();
}
function runBtn(b){
  var go=function(extra){ api('/api/action',Object.assign({id:b.id},extra||{})).then(function(r){
      if(r&&r.ok===false) toast(b.label+': '+(r.error||'failed'),'bad');
      else { toast(b.label+(r&&r.note?': '+r.note:' - done'),'ok'); if(r&&r.output!==undefined||b.id==='check') {showPage('console');showTab('act');} }
    })};
  if(b.confirm||b.typeToConfirm) dlg(b.label,b.confirm||'Are you sure?',b.typeToConfirm,b.label).then(function(v){ if(v) go({confirmText:typeof v==='string'?v:''}) });
  else go();
}
var lastClick=0;document.addEventListener('click',function(){lastClick=Date.now()},true);
function showTab(t){tab=t;if(t==='act'){var pa0=document.querySelector('.tab[data-tab="act"]');if(pa0)pa0.classList.remove('ping')}document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x.dataset.tab===t)});$('#log').hidden=t!=='log';$('#act').hidden=t!=='act';$('#chg').hidden=t!=='chg';$('#logtools').style.visibility=t==='log'?'visible':'hidden';if(t==='chg')loadChanges()}
var chgRows=[];
function chgRow(e){
  var d=el('div','chgrow'+(e.ok===false?' bad':''));
  d.appendChild(el('span','dim',new Date(e.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})));
  d.appendChild(el('span','k',e.kind));d.appendChild(el('span','d',e.detail));return d;
}
function loadChanges(){api('/api/changes').then(function(r){var b=$('#chg');b.textContent='';(r||[]).slice().reverse().forEach(function(e){b.appendChild(chgRow(e))})})}
function addChange(e){var b=$('#chg');if(b.hidden)return;b.insertBefore(chgRow(e),b.firstChild)}
function setAuto(group,field,value){api('/api/auto',{group:group,field:field,value:value}).then(function(r){if(r.ok===false)toast(r.error,'bad')})}
function renderAuto(){
  var a=state.auto,box=$('#auto'),sig=JSON.stringify(a);
  if(box.dataset.sig===sig||box.contains(document.activeElement)&&document.activeElement.tagName==='INPUT'&&document.activeElement.type==='text')return;
  box.dataset.sig=sig;box.textContent='';
  function chk(g,f,label,extra){var r=el('div','arow');var l=el('label');var c=el('input');c.type='checkbox';c.checked=!!a[g][f];c.onchange=function(){setAuto(g,f,c.checked)};l.appendChild(c);l.appendChild(el('span','',label));r.appendChild(l);if(extra)r.appendChild(extra);box.appendChild(r);return r}
  function num(g,f,unit,w){var s=el('span','dim');var i=el('input');i.type='text';i.value=a[g][f];i.size=w||3;i.setAttribute('aria-label',g+' '+f);i.onchange=function(){setAuto(g,f,g==='daily'?i.value:Number(i.value))};s.appendChild(i);s.appendChild(document.createTextNode(' '+unit));return s}
  chk('restart','enabled','Restart after a crash',num('restart','maxPerHour','max / hour'));
  chk('daily','enabled','Daily restart at',num('daily','time','',5));
  chk('backup','enabled','Back up every',num('backup','everyHours','hours'));
  chk('backup','beforeRestart','Back up before a daily restart');
  box.appendChild(el('div','dim','Stopping from here never triggers a restart. Closing the server window or a crash does, if the first box is ticked.')).style.fontSize='12px';
}
function renderBackups(){
  var box=$('#bklist'),sig=JSON.stringify([state.backups,state.fullBackups]);if(box.dataset.sig===sig)return;box.dataset.sig=sig;box.textContent='';
  if(!state.backups.length)box.appendChild(el('div','dim','No backups yet.'));
  state.backups.slice(0,6).forEach(function(b){var d=el('div','bk');d.appendChild(el('span',b.type==='db'?'ok':'dim',b.type));d.appendChild(el('span','',new Date(b.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})));d.appendChild(el('span','dim',b.size>1048576?(b.size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b.size/1024))+' KB'));box.appendChild(d)});
  $('#bkwhere').textContent=state.backupsDir;
  var bs=$('#bksum');bs.textContent='';
  function bsum(k,v,c){var sp=el('span','');sp.appendChild(el('span','dim',k+': '));sp.appendChild(el('b',c||'',v));bs.appendChild(sp)}
  var lb=state.lastBackupAt;bsum('Last backup',lb?new Date(lb).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'never',lb&&Date.now()-lb<172800000?'ok':'warn');
  var fb=state.fullBackups||[];bsum('Full backups',String(fb.length),fb.length?'':'warn');
  bsum('Other backups',String(state.backups.length));
  renderFull();
}
function backup(what,btn){btn.disabled=true;api('/api/backup',{what:what}).then(function(r){btn.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast(r.note||'Backed up','ok')})}
$('#bBkAll').onclick=function(){backup('all',this)};$('#bBkDb').onclick=function(){backup('db',this)};$('#bBkCfg').onclick=function(){backup('config',this)};$('#bBkScr').onclick=function(){backup('scripts',this)};
document.querySelectorAll('.tab').forEach(function(x){x.onclick=function(){showTab(x.dataset.tab)}});
document.querySelectorAll('.chip').forEach(function(c){c.onclick=function(){level=c.dataset.lv;document.querySelectorAll('.chip').forEach(function(z){z.classList.toggle('on',z===c)});redraw()}});
$('#find').oninput=redraw;
$('#bClear').onclick=function(){lines=[];redraw()};
$('#bCopy').onclick=function(){var t=lines.filter(visible).map(function(e){return ts(e.t)+' '+e.m}).join('\n');navigator.clipboard.writeText(t).then(function(){toast('Log copied','ok')},function(){toast('Copy blocked by the browser','bad')})};
$('#bStart').onclick=function(){api('/api/server/start',{}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast('Starting - a server window opens','ok')})};
$('#bStop').onclick=function(){dlg('Stop the server?','Players are disconnected. The server is asked to shut down cleanly first.',null,'Stop server').then(function(v){if(v)api('/api/server/stop',{}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast(r.clean===false?'Server was forced to stop':'Server stopped','ok')})})};
$('#bRestart').onclick=function(){dlg('Restart the server?','Players are disconnected while it restarts.',null,'Restart').then(function(v){if(v)api('/api/server/restart',{}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast('Restarting','ok')})})};
var actBox=$('#act'),actCur=0,vActId=0;
function actLine(t,c){var d=el('div','ln '+(c||''),t);actBox.appendChild(d);actBox.scrollTop=actBox.scrollHeight}
var resData=null,resGroup='custom',resQ='',resShut={};
try{resShut=JSON.parse(localStorage.getItem('vnrResShut')||'{}')||{}}catch(e){resShut={}}
function resSave(){try{localStorage.setItem('vnrResShut',JSON.stringify(resShut))}catch(e){}}
function loadRes(){
  api('/api/resources').then(function(r){
    if(r.error){var box=$('#reslist');box.textContent='';box.appendChild(el('div','bad pad',r.error));return}
    resData=r;drawRes();heads();
  });
}
function resDone(res){ if(res.ok===false) toast(res.error,'bad'); else if(res.note) toast(res.note,'ok'); loadRes() }
function drawRes(){
  var r=resData;if(!r)return;
  if(resGroup!=='all'&&!r.rows.some(function(x){return x.group===resGroup}))resGroup='all';
  var box=$('#reslist');box.textContent='';
  var q=resQ.trim().toLowerCase();
  $('#rescount').textContent='('+r.rows.length+' in the load list, '+r.available.length+' more on disk)';
  var chips=$('#reschips');chips.textContent='';
  function chip(id,label,n){var c=el('button','chip'+(resGroup===id?' on':''),label+' '+n);c.onclick=function(){resGroup=id;drawRes()};chips.appendChild(c)}
  chip('all','All',r.rows.length);
  r.groups.forEach(function(g){chip(g.id,g.label.replace(/ \(.*\)/,''),r.rows.filter(function(x){return x.group===g.id}).length)});
  var shown=0;
  r.groups.forEach(function(g){
    if(resGroup!=='all'&&resGroup!==g.id)return;
    var rows=[];r.rows.forEach(function(x,i){if(x.group!==g.id)return;if(q&&(x.path+' '+(x.name||'')).toLowerCase().indexOf(q)<0)return;rows.push([x,i])});
    var all=r.rows.filter(function(x){return x.group===g.id}).length;
    if(!rows.length&&(q||!all))return;
    var gd=el('div','rg g-'+g.id);
    var shut=!!resShut[g.id]&&!q;
    var h=el('div','rgh');h.tabIndex=0;h.setAttribute('role','button');h.setAttribute('aria-expanded',shut?'false':'true');
    h.appendChild(el('span','',shut?'▸':'▾'));h.appendChild(el('b','',g.label));
    h.appendChild(el('span','badge',rows.length===all?all+' loaded':rows.length+' of '+all));
    var miss=rows.filter(function(p){return !p[0].exists}).length,need=rows.filter(function(p){return p[0].needs&&p[0].needs.length}).length;
    if(miss)h.appendChild(el('span','badge bad',miss+' not found on disk'));
    if(need)h.appendChild(el('span','badge warn',need+' missing a dependency'));
    h.appendChild(el('span','hint dim',g.hint));
    var tg=function(){resShut[g.id]=!resShut[g.id];resSave();drawRes()};
    h.onclick=tg;h.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();tg()}};
    gd.appendChild(h);
    if(!shut)rows.forEach(function(p){
      var x=p[0],i=p[1];shown++;
      var d=el('div','res2');d.title=(x.name||'')+(x.version?' '+x.version:'');d.appendChild(el('div','n','#'+(i+1)));d.appendChild(el('div','p',x.path));
      var m=el('div','m '+(x.exists?'dim':'bad'),x.exists?(x.name+(x.version?' '+x.version:'')):'NOT FOUND on disk');
      if(x.needs&&x.needs.length){m.appendChild(document.createElement('br'));m.appendChild(el('span','warn','needs, not loaded: '+x.needs.join(', ')))}
      d.appendChild(m);
      var b=el('div','b');
      [['↑','up'],['↓','down']].forEach(function(a){var y=el('button','',a[0]);y.title='move one place '+a[1]+' in the load order';y.setAttribute('aria-label',y.title+': '+x.path);y.onclick=function(){api('/api/resources/move',{path:x.path,dir:a[1]}).then(resDone)};b.appendChild(y)});
      var rm=el('button','',"✕");rm.title='remove from load list';rm.setAttribute('aria-label','remove '+x.path+' from the load list');rm.onclick=function(){dlg('Remove '+x.path+'?','It stays on disk; it just stops loading on boot. server.jsonc is backed up first. Needs a restart.',null,'Remove').then(function(v){if(v)api('/api/resources/remove',{path:x.path}).then(resDone)})};b.appendChild(rm);
      d.appendChild(b);gd.appendChild(d);
    });
    box.appendChild(gd);
  });
  if(!box.childNodes.length)box.appendChild(el('div','dim pad',q?'Nothing matches "'+resQ+'".':'The load list is empty.'));
  var sel=$('#resadd');sel.textContent='';var o=el('option','','add a resource that is on disk but not loaded...');o.value='';sel.appendChild(o);
  r.groups.forEach(function(g){var av=r.available.filter(function(a){return a.group===g.id});if(!av.length)return;var og=document.createElement('optgroup');og.label=g.label;av.forEach(function(a){var o=el('option','',a.path);o.value=a.path;og.appendChild(o)});sel.appendChild(og)});
  $('#resfold').textContent=r.groups.every(function(g){return resShut[g.id]})?'Expand all':'Collapse all';
}
$('#resfind').oninput=function(){resQ=this.value;drawRes()};
$('#resfold').onclick=function(){if(!resData)return;var all=resData.groups.every(function(g){return resShut[g.id]});resData.groups.forEach(function(g){resShut[g.id]=!all});resSave();drawRes()};
$('#bAdd').onclick=function(){var v=$('#resadd').value;if(!v)return;api('/api/resources/add',{path:v}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast(r.note||'Added','ok');loadRes()})};

var upd=null;
function fsize(n){return n>1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
function loadUpd(){loadPg();api('/api/updates').then(function(r){if(r&&r.packs){upd=r;renderUpd();heads()}})}
function renderUpd(){
  var box=$('#updlist');box.textContent='';
  var nsrc=upd.packs.filter(function(p){return p.source}).length;
  $('#updAllNote').textContent=nsrc?(upd.autoDownload?(upd.autoApply?'Checked automatically in the background: new versions are downloaded, backed up and installed while the server is off (or press "Update everything now"). Every update is written to update_log.md.':'Checked automatically in the background; installing is your button press (backup first). Every update is written to update_log.md.'):'Automatic download is off (update.autoDownload in dashboard.json).'):'Enter a GitHub address on a pack below to start. The official server and resource zips need your open2077.net sign-in, so those stay a manual download.';
  upd.packs.forEach(function(p){
    var d=el('div','upk'),h=el('div','h');h.appendChild(el('b','',p.label));h.appendChild(el('span','dim',p.installed?'installed: '+p.installed:'not installed'));h.appendChild(el('span','badge '+(p.zips.length?'ok':'warn'),!p.zips.length?'no zip':(utd[p.id]&&p.zips.some(function(z){return z.name===utd[p.id]})?'up to date':'zip ready')));d.appendChild(h);
    var sel=null;
    if(p.zips.length){
      if(p.zips.length>1){sel=el('select');p.zips.forEach(function(z){var o=el('option','',z.name+' ('+fsize(z.size)+')');o.value=z.name;sel.appendChild(o)});d.appendChild(sel)}
      else d.appendChild(el('div','m dim','zip found: '+p.zips[0].name+' ('+fsize(p.zips[0].size)+')'));
    } else d.appendChild(el('div','m warn','no zip found - drop it in the updates folder'));
    if(p.canSource){
      var sr=el('div','usrc'),si=el('input');si.type='text';si.placeholder='GitHub address, owner/name';si.value=p.source||'';si.setAttribute('aria-label','GitHub repository for '+p.label);si.spellcheck=false;
      var sb=el('button','','Save source');sb.onclick=function(){sb.disabled=true;api('/api/update/source',{pack:p.id,repo:si.value}).then(function(r){sb.disabled=false;if(r.ok===false)toast(r.error,'bad');else{toast(r.note,'ok');loadUpd()}})};
      sr.appendChild(si);sr.appendChild(sb);d.appendChild(sr);
      if(p.source)d.appendChild(el('div','m dim','downloads from github.com/'+p.source+(p.sourceBranch?' ('+p.sourceBranch+')':'')+(p.dl?'  -  last downloaded '+p.dl.sha+' '+relT(p.dl.at):'  -  not downloaded yet')));
    }
    var bb=el('div','bb');
    var chk=el('button','go','Check & update');chk.disabled=!p.zips.length;chk.onclick=function(){chk.disabled=true;api('/api/update/plan',{pack:p.id,zip:sel?sel.value:''}).then(function(r){chk.disabled=false;if(r.ok===false)toast(r.error,'bad');else showPlan(r)})};bb.appendChild(chk);
    if(p.hasUrl){var dl=el('button','',p.source?'Download latest':'Download');dl.onclick=function(){dl.disabled=true;api('/api/update/download',{pack:p.id}).then(function(r){dl.disabled=false;if(r.ok===false)toast(r.error,'bad');else{toast(r.note,'ok');loadUpd()}})};bb.appendChild(dl)}
    d.appendChild(bb);box.appendChild(d);
  });
  $('#updwhere').textContent='Updates folder: '+upd.dirs[0];
  (function(h){h.textContent='';var b=document.createElement('b');b.textContent='How to update: ';h.appendChild(b);h.appendChild(document.createTextNode('put the update zip you downloaded for your server files inside this updates folder, keep its original name, then press the check button. The panel backs up first and installs it while the server is off.'));var p=document.createElement('div');p.className='updpath';p.textContent=upd.dirs[0];h.appendChild(p);var g=document.createElement('div');g.style.marginTop='6px';g.appendChild(document.createTextNode('Get the official server files: '));var a=document.createElement('a');a.href='https://open2077.net/host';a.target='_blank';a.rel='noopener noreferrer';a.textContent='open2077.net/host';g.appendChild(a);h.appendChild(g)})($('#updhow'));
  var hb=$('#updhist');hb.textContent='';
  upd.history.forEach(function(j){
    var d=el('div','bk');d.appendChild(el('span',j.status==='done'?'ok':'dim',j.status));d.appendChild(el('span','',j.label+' '+j.from+' → '+j.to));
    if(false&&j.canRollback){var b=el('button','','Roll back');b.style.padding='1px 8px';b.onclick=function(){dlg('Roll back '+j.label+'?','Puts back every file this update replaced and removes the files it added. The server must be stopped.','ROLLBACK','Roll back').then(function(v){if(v)api('/api/update/rollback',{id:j.id,confirmText:v}).then(function(r){if(r.ok===false)toast(r.error,'bad');else{toast(r.note,'ok');loadUpd()}})})};d.appendChild(b)}else d.appendChild(el('span','dim',''));
    var rb=el('button','','What changed');rb.style.padding='1px 8px';rb.style.whiteSpace='nowrap';rb.onclick=function(){showReport(j.id)};d.appendChild(rb);
    hb.appendChild(d);
  });
}
/* ---- monitor page ---- */
var mon={pts:[],range:900,since:0,timer:null,last:null,rh:{},sel:null,hover:{}};
function monStart(){if(mon.timer)return;monPoll();mon.timer=setInterval(monPoll,3000)}
function monStop(){if(mon.timer){clearInterval(mon.timer);mon.timer=null}}
function monPoll(){api('/api/monitor?since='+mon.since+'&res='+encodeURIComponent(mon.sel||'')).then(function(r){
  if(!r||!r.points)return;mon.last=r;
  r.points.forEach(function(p){mon.pts.push(p);if(p.t>mon.since)mon.since=p.t});
  if(mon.pts.length>1300)mon.pts.splice(0,mon.pts.length-1300);
  monDraw();
})}
function fnum(v,d){return v==null||isNaN(v)?'—':v.toFixed(d==null?0:d)}
function monTile(box,k,v,c,sub,tip){var d=el('div','tile '+(c||''));d.appendChild(el('div','k',k));d.appendChild(el('div','v',v));if(sub)d.appendChild(el('div','s',sub));if(tip)d.title=tip;box.appendChild(d)}
function lastOf(f){for(var i=mon.pts.length-1;i>=0;i--){if(mon.pts[i][f]!=null)return mon.pts[i]}return null}
function monDraw(){
  var r=mon.last;if(!r)return;var m=r.metrics,p=mon.pts.length?mon.pts[mon.pts.length-1]:null;
  var live=m.state==='live';
  var bn=$('#monbanner');
  if(!r.running){bn.hidden=false;bn.textContent='The game server is not running, so there is nothing to measure. The graphs keep what was measured while it ran.'}
  else if(!live){bn.hidden=false;bn.textContent='';
    bn.appendChild(el('span','','Process CPU and memory come from the operating system. Players, tick time and per-resource cost need Open77’s metrics endpoint: '+(m.note||m.state)));
    if(m.state==='off'){var eb=el('button','go','Enable metrics (loopback only)');eb.onclick=function(){dlg('Enable the metrics endpoint?','Adds a "metrics" section to server.jsonc (enabled, 127.0.0.1:11783, read-only, no commands). A backup of server.jsonc is kept first. Restart the server afterwards.',null,'Enable').then(function(v){if(v)api('/api/monitor/enable',{}).then(function(x){toast(x.ok===false?x.error:x.note,x.ok===false?'bad':'ok')})})};bn.appendChild(eb)}}
  else bn.hidden=true;
  var c=lastOf('cpu'),mm=lastOf('rssMB'),pl=lastOf('players'),tk=lastOf('tickP95'),mb=lastOf('mbps'),up=lastOf('uptime');
  var live2=function(x){return r.running?x:null};
  var tb=$('#montiles');tb.textContent='';
  monTile(tb,'Server CPU',c&&r.running?fnum(c.cpu,1)+' %':'—',c&&c.cpu>80?'bad':c&&c.cpu>50?'warn':'ok',c&&r.running?fnum(c.cores,2)+' of '+r.cores+' cores':'','Share of the whole machine used by the game server process (operating system counters).');
  monTile(tb,'Server memory',mm&&r.running?fnum(mm.rssMB,0)+' MB':'—','',mm&&r.running?'machine RAM in use '+fnum(p&&p.sysUsed,0)+' %':'','Working set of the game server process.');
  monTile(tb,'Players',pl&&live?fnum(pl.ready,0)+' / '+fnum(pl.players,0):'—',live?'ok':'','ready / connected',live?'open77_players_ready / open77_players_connected':'needs the metrics endpoint');
  monTile(tb,'Tick p95',tk&&live?fnum(tk.tickP95,1)+' ms':'—',tk&&tk.tickP95>16.7?'warn':'ok',tk&&live&&tk.tickMax!=null?'worst '+fnum(tk.tickMax,1)+' ms':'',m.tickFamily||'needs the metrics endpoint');
  monTile(tb,'Network out',mb&&live?fnum(mb.mbps,2)+' Mbit/s':'—','','application bytes sent','open77_transport_sent_bytes_total (not NIC traffic)');
  monTile(tb,'Server uptime',up&&live?fmtDur(up.uptime):'—','','','open77_uptime_seconds');
  setChips('monitor',[[live?'ok':'warn','Metrics',live?'live':m.state],['info','Sampling','every 3 s']]);
  var t1=r.now,t0=monT0(t1,mon.pts.length?mon.pts[0].t:t1);
  function ser(f){return mon.pts.map(function(q){return [q.t,q[f]]})}
  chart($('#cCpu'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return v.toFixed(d)+' %'},min:10,series:[{label:'game server',color:'--cy',pts:ser('cpu')},{label:'machine',color:'--dim',pts:ser('sysCpu'),dash:true}]},'cpu');
  $('#mh_cpu').textContent=c&&r.running?'game server '+fnum(c.cpu,1)+' %  ·  machine '+fnum(lastOf('sysCpu')&&lastOf('sysCpu').sysCpu,0)+' %':'';
  chart($('#cMem'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return v.toFixed(d)+' MB'},min:100,series:[{label:'game server',color:'--mg',pts:ser('rssMB')}]},'mem');
  $('#mh_mem').textContent=mm&&r.running?fnum(mm.rssMB,0)+' MB of '+r.totalMemMB+' MB':'';
  chart($('#cPly'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return v.toFixed(d)},min:4,series:[{label:'connected',color:'--cy',pts:ser('players')},{label:'ready',color:'--ok',pts:ser('ready')}],none:live?null:'needs the metrics endpoint'},'ply');
  $('#mh_ply').textContent=pl&&live?fnum(pl.ready,0)+' ready / '+fnum(pl.players,0)+' connected':'';
  chart($('#cTick'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return v.toFixed(d)+' ms'},min:20,series:[{label:'p95',color:'--warn',pts:ser('tickP95')},{label:'worst',color:'--bad',pts:ser('tickMax'),dash:true}],none:live?null:'needs the metrics endpoint'},'tick');
  $('#mh_tick').textContent=tk&&live?'latest window p95 '+fnum(tk.tickP95,1)+' ms':'';
  monRes(r,live);
}
function monT0(t1,first){return t1-Math.min(mon.range*1000,Math.max(60000,t1-first+3000))}
function fmtDur(s){s=Math.round(s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m '+(s%60)+'s'}
function monRes(r,live){
  var box=$('#restab'),sy=box.scrollTop;box.textContent='';setTimeout(function(){box.scrollTop=sy},0);var key=$('#monsort').value,rows=r.res.slice();
  if(!live||!rows.length){$('#mh_res').textContent='';box.appendChild(el('div','dim',live?'No per-resource data in the endpoint yet.':'Per-resource cost comes from the metrics endpoint (see the banner).'));$('#resname').textContent='-';$('#resnote').textContent='';chart($('#cRes'),{t0:0,t1:1,series:[],none:'no data'},'res');chart($('#cResMem'),{t0:0,t1:1,series:[],none:'no data'},'resmem');return}
  rows.sort(function(a,b){return (b[key]||0)-(a[key]||0)});
  var fam=r.resFam;$('#mh_res').textContent=rows.length+' resources';
  var h=el('div','rr rh');['resource','memory','sched','event','calls/s','fail'].forEach(function(t){h.appendChild(el('span','',t))});
  h.title='memory: '+(fam.mem||'not exported')+' (VM-reported, not resident). sched/event: wall time per second, rate of '+(fam.sched||'?')+' / '+(fam.ev||'?')+'. calls/s: '+(fam.calls||'not exported')+'. fail: '+(fam.fail||'not exported');box.appendChild(h);
  var bytes=/bytes/.test(fam.mem||'');
  var tm=function(x){return x.mem==null?'—':(bytes?(x.mem>=1048576?fnum(x.mem/1048576,1)+' MB':fnum(x.mem/1024,0)+' KB'):fnum(x.mem,0))};
  if(!mon.sel||!rows.some(function(x){return x.name===mon.sel}))mon.sel=rows[0].name;
  rows.forEach(function(x){
    var d=el('div','rr'+(x.name===mon.sel?' sel':''));d.appendChild(el('span','nm',x.name));d.title=x.name+(x.run!=null?(x.run?' (running)':' (not running)'):'')+(x.max!=null?'  worst call '+fnum(x.max*1000,1)+' ms':'')+(x.slow!=null?'  slow ticks '+x.slow:'')+(x.gen!=null?'  reload generation '+x.gen:'');
    d.appendChild(el('span','',tm(x)));d.appendChild(el('span','',fnum(x.sched,2)));d.appendChild(el('span','',fnum(x.ev,2)));
    d.appendChild(el('span','',fnum(x.calls,1)));d.appendChild(el('span',x.fail>0?'bd':'',x.fail==null?'—':fnum(x.fail,0)));
    d.onclick=function(){mon.sel=x.name;mon.since=mon.since;monPoll()};box.appendChild(d)});
  $('#resname').textContent=mon.sel;var hh=r.rh||[];
  $('#resnote').textContent=hh.length?'history kept by the launcher while it runs':'collecting…';
  var t1=r.now,t0=monT0(t1,hh.length?hh[0][0]:t1);
  chart($('#cRes'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return v.toFixed(d)+' ms/s'},min:1,series:[{label:'scheduler',color:'--cy',pts:hh.map(function(q){return [q[0],q[1]]})},{label:'events',color:'--mg',pts:hh.map(function(q){return [q[0],q[2]]})}]},'res');
  chart($('#cResMem'),{t0:t0,t1:t1,ymin:0,fmt:function(v,d){return bytes?(v/1048576).toFixed(d)+' MB':v.toFixed(d)},min:bytes?1048576:1,series:[{label:'VM memory',color:'--ok',pts:hh.map(function(q){return [q[0],q[3]]})}],none:fam.mem?null:'memory is not exported'},'resmem');
}
function chart(cv,o,id){
  if(!cv)return;var dpr=window.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;if(w<20||h<20)return;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr)}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var cs=getComputedStyle(document.documentElement),col=function(n){return cs.getPropertyValue(n).trim()||'#888'};
  var L=60,R=10,T=22,B=18,pw=w-L-R,ph=h-T-B;
  var mx=0;o.series.forEach(function(s){s.pts.forEach(function(q){if(q[0]>=o.t0&&q[1]!=null&&q[1]>mx)mx=q[1]})});
  var top=Math.max(o.min||1,mx*1.15);var mag=Math.pow(10,Math.floor(Math.log10(top))),nn=top/mag;top=(nn<=1?1:nn<=2?2:nn<=4?4:nn<=8?8:10)*mag;var dec=top<5?2:top<20?1:0;
  var X=function(t){return L+(t-o.t0)/(o.t1-o.t0)*pw},Y=function(v){return T+ph-(v-(o.ymin||0))/(top-(o.ymin||0))*ph};
  g.font='11px Inter,system-ui,sans-serif';g.fillStyle=col('--dim');g.strokeStyle=col('--line');g.lineWidth=1;
  for(var i=0;i<=4;i++){var v=(o.ymin||0)+(top-(o.ymin||0))*i/4,y=Math.round(Y(v))+.5;g.beginPath();g.moveTo(L,y);g.lineTo(w-R,y);g.stroke();g.textAlign='right';g.textBaseline='middle';g.fillText(o.fmt?o.fmt(v,dec):v.toFixed(dec),L-5,y)}
  g.textAlign='center';g.textBaseline='top';var span=(o.t1-o.t0)/1000;
  [0,.25,.5,.75,1].forEach(function(f){var s=Math.round(span*(1-f));g.fillText(f===1?'now':'-'+(s>=120?Math.round(s/60)+' min':s+' s'),L+pw*f,h-B+4)});
  var any=false;
  o.series.forEach(function(s){
    g.strokeStyle=col(s.color);g.lineWidth=1.6;g.setLineDash(s.dash?[5,4]:[]);g.beginPath();var pen=false,lx=null;
    s.pts.forEach(function(q){if(q[0]<o.t0-6000)return;if(q[1]==null){pen=false;return}any=true;var x=X(q[0]),y=Y(q[1]);if(!pen||(lx!==null&&q[0]-lx>9000)){g.moveTo(x,y);pen=true}else g.lineTo(x,y);lx=q[0]});g.stroke();g.setLineDash([])});
  var lg=0;o.series.forEach(function(s){g.fillStyle=col(s.color);g.fillRect(L+6+lg,T-12,10,3);g.fillStyle=col('--dim');g.textAlign='left';g.textBaseline='middle';g.fillText(s.label,L+20+lg,T-10);lg+=g.measureText(s.label).width+34});
  if(!any){g.fillStyle=col('--dim');g.textAlign='center';g.textBaseline='middle';g.font='13px Inter,system-ui,sans-serif';g.fillText(o.none||'no measurements in this range',L+pw/2,T+ph/2)}
  var hv=mon.hover[id];if(hv&&hv.x>=L&&hv.x<=w-R&&any){
    var tt=o.t0+(hv.x-L)/pw*(o.t1-o.t0);g.strokeStyle=col('--dim');g.setLineDash([2,3]);g.beginPath();g.moveTo(hv.x+.5,T);g.lineTo(hv.x+.5,T+ph);g.stroke();g.setLineDash([]);
    var txt=[];o.series.forEach(function(s){var best=null;s.pts.forEach(function(q){if(q[1]!=null&&(best===null||Math.abs(q[0]-tt)<Math.abs(best[0]-tt)))best=q});if(best&&Math.abs(best[0]-tt)<8000){txt.push(s.label+' '+(o.fmt?o.fmt(best[1]):best[1].toFixed(1)));g.fillStyle=col(s.color);g.beginPath();g.arc(X(best[0]),Y(best[1]),3,0,6.3);g.fill()}});
    if(txt.length){var ago=Math.round((o.t1-tt)/1000);var line=txt.join('   ')+'   ('+(ago>=120?Math.round(ago/60)+' min':ago+' s')+' ago)';g.font='11px Inter,system-ui,sans-serif';var tw=g.measureText(line).width+12,tx=Math.min(Math.max(hv.x-tw/2,L),w-R-tw);g.fillStyle=col('--panel');g.strokeStyle=col('--line');g.fillRect(tx,T+16,tw,18);g.strokeRect(tx+.5,T+16.5,tw,18);g.fillStyle=col('--txt');g.textAlign='left';g.textBaseline='middle';g.fillText(line,tx+6,T+25)}
  }
}
['cCpu','cMem','cPly','cTick','cRes'].forEach(function(id){var c=$('#'+id),k=id.slice(1).toLowerCase();c.onmousemove=function(e){var b=c.getBoundingClientRect();mon.hover[k]={x:e.clientX-b.left};monDraw()};c.onmouseleave=function(){mon.hover[k]=null;monDraw()}});
document.querySelectorAll('#monrng button').forEach(function(b){b.onclick=function(){mon.range=+b.dataset.r;document.querySelectorAll('#monrng button').forEach(function(z){z.classList.toggle('on',z===b)});monDraw()}});
$('#monsort').onchange=monDraw;
window.addEventListener('resize',function(){if(curPage==='monitor')monDraw()});

var pgd=null;
function loadPg(){api('/api/patches').then(function(r){if(r&&r.counts){pgd=r;drawPg()}})}
function drawPg(){
  var c=pgd.counts,b=$('#pgsum');b.textContent='';
  $('#pgwhen').textContent=pgd.saved?'last saved '+new Date(pgd.saved).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'nothing saved yet';
  function chip(t,cls){b.appendChild(el('span','badge '+cls,t))}
  if(!c.total){b.appendChild(el('span','dim','No patched files saved yet. Press "Save patched files now" - it finds every file that differs from the release and keeps a copy.'));return}
  chip(c.total+' tracked','ok');
  chip(c.ok+' unchanged',c.ok===c.total?'ok':'dim');
  if(c.changed)chip(c.changed+' edited since saved','warn');
  if(c.reverted)chip(c.reverted+' back to upstream','warn');
  if(c.missing)chip(c.missing+' missing','bad');
  if(c.pending)chip(c.pending+' waiting for a merge','warn');
  if(c.noBase)chip(c.noBase+' without a saved original','dim');
}
$('#bPgSave').onclick=function(){var b=this;b.disabled=true;toast('Scanning for patched files ...');api('/api/patches/snapshot',{}).then(function(r){b.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok');loadPg()})};
$('#bPgApply').onclick=function(){var b=this;b.disabled=true;api('/api/patches/apply',{}).then(function(r){b.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast('Patched files: '+r.note,'ok');loadPg();if(r.results&&r.results.length)showPgList(r.results)})};
$('#bPgList').onclick=function(){showPgList(null)};
function showPgList(rs){
  var d=$('#pdlg'),b=$('#pdbody');b.textContent='';
  var rows=rs||(pgd?pgd.rows.map(function(x){return {rel:x.rel,state:x.state+(x.pending?' +NEW':''),note:(x.added?'added by us':'patched')+(x.hasBase||x.added?'':', original not saved')}}):[]);
  $('#pdsum').textContent=rs?'Result of the check (files that were already fine are left out):':(pgd?pgd.counts.total+' tracked in '+pgd.dir:'');
  if(!rows.length)b.appendChild(el('div','dim','Nothing to show.'));
  rows.forEach(function(x){var l=el('div',x.state&&/^(ok|intact)/.test(x.state)?'dim':(/merge|changed|reverted|missing/.test(x.state)?'warn':'ok'),String(x.state).toUpperCase().padEnd(16,' ')+x.rel+(x.note?'   - '+x.note:''));b.appendChild(l)});
  $('#pdclose').onclick=function(){d.close()};d.showModal();
}
var utd={};
function showReport(id){
  api('/api/update/report',{id:id}).then(function(r){
    if(!r||r.ok===false){toast((r&&r.error)||'No report','bad');return}
    var d=$('#rdlg'),rp=r.report,gs=rp.groups,nm=0;gs.forEach(function(g){nm+=g.conflicts.length});
    $('#rtitle').textContent='What changed: '+r.label+' '+r.from+' \u2192 '+r.to;
    var sm=$('#rsum');sm.textContent='';
    sm.appendChild(document.createTextNode(new Date(r.at).toLocaleString()+' \u00b7 '+gs.length+' resource'+(gs.length===1?'':'s')+' touched \u00b7 '));
    var nb=el('b',nm?'warn':'ok',nm?nm+' file'+(nm===1?'':'s')+' need a merge':'nothing needs a merge');sm.appendChild(nb);
    var b=$('#rbody');b.textContent='';
    if(!gs.length)b.appendChild(el('div','dim','No files were changed by this update.'));
    gs.forEach(function(g){
      var c=el('div','rpg'),h=el('div','h');h.appendChild(el('b','',g.name));
      if(g.verFrom||g.verTo)h.appendChild(el('span','dim','version '+(g.verFrom||'?')+' \u2192 '+(g.verTo||'?')));
      if(g.conflicts.length)h.appendChild(el('span','badge warn',g.conflicts.length+' need merge'));
      if(g.replaced.length)h.appendChild(el('span','badge ok',g.replaced.length+' replaced'));
      if(g.added.length)h.appendChild(el('span','badge ok',g.added.length+' added'));
      c.appendChild(h);
      g.conflicts.forEach(function(x){c.appendChild(el('div','mg','NEEDS MERGE  '+x.file+'   (new upstream copy: '+x.copy+')'))});
      [['Replaced files',g.replaced],['Added files',g.added]].forEach(function(t){
        if(!t[1].length)return;var dt=el('details'),sy=el('summary','',t[0]+' ('+t[1].length+')');dt.appendChild(sy);
        dt.appendChild(el('div','fl',t[1].slice(0,200).join('\n')+(t[1].length>200?'\n... and '+(t[1].length-200)+' more':'')));c.appendChild(dt)});
      b.appendChild(c);
    });
    if(rp.patchCounts||rp.patchError){
      var pc=el('div','rpg'),ph=el('div','h');ph.appendChild(el('b','','Your patched files'));
      if(rp.patchCounts)Object.keys(rp.patchCounts).forEach(function(k){ph.appendChild(el('span','badge '+(k==='needsmerge'||k==='changed'||k==='nostore'?'warn':'ok'),rp.patchCounts[k]+' '+k))});
      pc.appendChild(ph);
      if(rp.patchError)pc.appendChild(el('div','mg','PROBLEM: '+rp.patchError));
      rp.patches.forEach(function(x){pc.appendChild(el('div',x.state==='needsmerge'||x.state==='changed'||x.state==='nostore'?'mg':'fl',x.state.toUpperCase()+'  '+x.rel+(x.note?'  - '+x.note:'')+(x.copy?'  (new upstream copy: '+x.copy+')':'')))});
      b.appendChild(pc);
    }
    if(rp.removed.length)b.appendChild(el('div','dim','No longer shipped upstream (left in place): '+rp.removed.slice(0,12).join(', ')+(rp.removed.length>12?' ... +'+(rp.removed.length-12)+' more':'')));
    rp.warnings.forEach(function(w){b.appendChild(el('div','warn','Note: '+w))});
    $('#rcopy').onclick=function(){navigator.clipboard.writeText(r.text).then(function(){toast('Report copied - paste it to Claude','ok')},function(){toast('Copy blocked by the browser','bad')})};
    $('#rclose').onclick=function(){d.close()};
    d.showModal();
  });
}
function showPlan(r){
  var d=$('#udlg'),c=r.counts;
  var same=!(r.problems&&r.problems.length)&&c.add+c.overwrite+c.conflict===0;
  if(same)utd[r.pack]=r.zip;else delete utd[r.pack];
  $('#uyes').hidden=same;$('#ulist').hidden=same;$('#uno').textContent=same?'Close':'Cancel';
  $('#utitle').textContent=r.label+': '+r.from+' → '+r.to;
  var b=$('#ubody');b.textContent='';
  if(same){$('#utitle').textContent=r.label+': up to date';b.appendChild(el('div','ok','You are already up to date. Every file in '+r.zip+' is identical to what is installed ('+r.to+'), so there is nothing to update.'));b.appendChild(el('div','dim','Checked '+c.same+' files'+(c.keep?', '+c.keep+' of yours kept':'')+'. Nothing was changed.'));$('#uwhy').style.display='none';$('#ustartw').style.display='none';$('#uno').onclick=function(){d.close()};d.showModal();$('#uno').focus();renderUpd();return}
  $('#ustartw').style.display='block';
  b.appendChild(el('div','dim',r.zip));
  b.appendChild(el('div','', c.add+' to add, '+c.overwrite+' to replace, '+c.same+' already identical, '+c.keep+' of yours kept, '+c.conflict+' conflicts'+(c.protected?', '+c.protected+' protected':'')));
  function list(arr,cls,title){if(!arr||!arr.length)return;b.appendChild(el('div',cls,title));var u=el('ul','pl');arr.forEach(function(x){u.appendChild(el('li',cls,x))});b.appendChild(u)}
  list(r.problems,'bad','Cannot apply:');list(r.warnings,'warn','Note:');list(r.notes,'dim','');
  if(c.conflict)b.appendChild(el('div','warn','Conflicts: your edited file stays; the new version is saved next to it as .NEW-... Ask Claude to merge them.'));
  b.appendChild(el('div','dim','The server is stopped first, then config + scripts + database are backed up, then files are replaced. Nothing is deleted. You can roll back afterwards.'));
  var L=$('#ulist');L.textContent='';
  r.rows.forEach(function(x){L.appendChild(el('div','a-'+x.action,x.action.toUpperCase().padEnd(10,' ')+x.rel))});
  if(r.rowsMore)L.appendChild(el('div','dim','... and '+r.rowsMore+' more'));
  if(r.removed&&r.removed.length)L.appendChild(el('div','dim','No longer in the release (left alone, not deleted): '+r.removed.join(', ')));
  if(r.available&&r.available.length)L.appendChild(el('div','dim','In the pack but not installed here (ignored): '+r.available.join(', ')));
  if(!L.childNodes.length)L.appendChild(el('div','dim','Nothing to change - already up to date.'));
  var isSrv=r.kind==='server';
  $('#ustart').checked=false;
  var yes=$('#uyes'),can=r.canApply&&(c.add+c.overwrite+c.conflict>0);yes.disabled=!can;yes.textContent=isSrv?'Update server':'Apply update';$('#ubk').textContent=r.backup?r.backup.text:'';
  var why=$('#uwhy');why.style.display=can?'none':'';why.textContent=!r.canApply?'The button is locked because this update cannot be applied: '+((r.problems&&r.problems[0])||'see the list above')+(r.problems&&r.problems.length>1?' (+'+(r.problems.length-1)+' more above)':''):'The button is locked because there is nothing to change: every file in this zip is already identical to what is installed ('+r.from+' -> '+r.to+').';
  $('#uno').onclick=function(){d.close()};
  yes.onclick=function(){
    yes.disabled=true;toast('Updating - watch the Action output tab ...');
    var go=function(extra){var o={planId:r.planId,confirm:true,startAfter:$('#ustart').checked};if(extra)for(var k in extra)o[k]=extra[k];return api('/api/update/apply',o)};
    var fin=function(a){d.close();if(a.ok===false)toast(a.error,'bad');else{toast(a.note,'ok');if(a.journal)showReport(a.journal)}loadUpd()};
    go().then(function(a){if(a&&a.needBackup){askBackup(a.error).then(function(c){if(!c){yes.disabled=false;return}toast('Updating - watch the Action output tab ...');go(c==='backup'?{backup:true}:{skipBackup:true}).then(fin)})}else fin(a)});
  };
  d.showModal();$('#uno').focus();
}

function pill(){var n=state&&state.watch?state.watch.count:0,b=$('#bWatch');b.hidden=!n;b.textContent=n+' update'+(n>1?'s':'')+' available';var nb=$('#nbUpd');nb.hidden=!n;nb.textContent=n;tiles()}
function tiles(){
  if(!state)return;var box=$('#tiles');box.textContent='';
  function t(k,v,c,sub){var d=el('div','tile '+(c||''));d.appendChild(el('div','k',k));d.appendChild(el('div','v',v));if(sub)d.appendChild(el('div','s',sub));box.appendChild(d)}
  var s=state.server.state;
  t('Game server',s.toUpperCase(),s==='online'?'ok':s==='offline'?'bad':'warn',s==='online'?(fmtUp(state.server.startedAt)+(state.ports.game?'  -  UDP '+state.ports.game:'')):(state.ports.game?'UDP '+state.ports.game:''));
  t('Database',state.db.up?'ONLINE':'DOWN',state.db.up?'ok':'bad','MariaDB, port '+state.db.port);
  t('Warden panel',state.ports.warden.up?'OPEN':'CLOSED',state.ports.warden.up?'ok':'','TCP '+state.ports.warden.port);
  t('Last backup',state.lastBackupAt?new Date(state.lastBackupAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'never',state.lastBackupAt&&Date.now()-state.lastBackupAt<172800000?'ok':'warn');
  var n=state.watch?state.watch.count:0;t('Updates',n?n+' available':'up to date',n?'warn':'ok');
  if(state.vps){var vs=state.vps.state||'unknown';t('VPS server',vs.toUpperCase(),vs==='online'?'ok':vs==='offline'?'bad':'warn')}
  $('#navdir').textContent=state.serverDir;perfDraw();
}
var curPage='dash';
function showPage(id){
  curPage=id;
  if(id==='vps')loadVps();
  if(id==='cmdlog')clLoad();
  if(id==='mods')loadMods();
  if(id==='server')loadServerInfo();
  if(id==='settings')loadSettings();
  if(id==='crashes')loadCrash();
  if(id==='monitor')monStart();else monStop();
  document.querySelectorAll('.page').forEach(function(p){p.classList.toggle('on',p.dataset.page===id)});
  document.querySelectorAll('.nav button').forEach(function(b){var on=b.dataset.page===id&&(!b.dataset.lock);b.classList.toggle('on',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  try{localStorage.setItem('vnrPage',id)}catch(e){}
  if(id==='console'){var l=$('#log');if($('#follow').checked)l.scrollTop=l.scrollHeight}
}
document.querySelectorAll('.nav button').forEach(function(b){b.onclick=function(){showPage(b.dataset.page)}});
(function(){var id='dash';try{id=localStorage.getItem('vnrPage')||'dash'}catch(e){}if(MODE==='vps')id='vps';if(!document.querySelector('.page[data-page="'+id+'"]'))id='dash';showPage(id)})();
$('#bWatch').onclick=function(){showPage('updates')};
$('#bUpdAuto').onclick=function(){dlg('Update everything now?','Downloads the newest version of every GitHub pack, checks you have a recent backup (and tells you if not), installs it and writes the update log. If the server is running it is stopped for the install and started again after. Anything that needs a decision is left alone and logged.',null,'Update now').then(function(v){if(!v)return;var b=$('#bUpdAuto');b.disabled=true;api('/api/update/auto',{}).then(function(r){b.disabled=false;toast((r&&(r.note||r.error))||'Done',r&&r.ok===false?'bad':'ok');loadUpd()})})};
$('#bUpdLog').onclick=function(){api('/api/update/openlog',{}).then(function(r){if(r&&r.ok)toast('Opened update_log.md','ok');else toast('Could not open the log','bad')})};
$('#bUpdAll').onclick=function(){var b=$('#bUpdAll');b.disabled=true;api('/api/update/downloadall',{}).then(function(r){b.disabled=false;if(r&&r.ok===false)toast(r.error||'Some downloads failed','bad');else toast((r&&r.note)||'Done','ok');loadUpd()})};
function renderFull(){
  var box=$('#fulllist');box.textContent='';var list=state.fullBackups||[];
  if(!list.length){box.appendChild(el('div','dim','None yet. Make one before updating (the updater also makes one by itself).'));return}
  list.slice(0,4).forEach(function(b){
    var d=el('div','upk'),h=el('div','h');h.appendChild(el('b','',b.name));
    h.appendChild(el('span','dim',b.broken?'incomplete':b.files+' files, '+fsize(b.bytes)+(b.db?' + database':', no database')));d.appendChild(h);
    if(b.warn)d.appendChild(el('div','m warn',b.warn));
    if(b.missing&&b.missing.length)d.appendChild(el('div','m dim','not there at the time: '+b.missing.join(', ')));
    var bb=el('div','bb');
    var v=el('button','','Verify');v.onclick=function(){v.disabled=true;api('/api/backup/verify',{name:b.name}).then(function(r){v.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok')})};if(!LITE_UI)bb.appendChild(v);
    if(!b.broken){var x=el('button','danger','Restore ...');x.onclick=function(){dlg('Restore full backup '+b.name+'?','The server must be stopped. The backup is checked first, then everything in it is copied back over the current files. What is there now is saved as a new full backup first, so this can be undone. The database is not touched.','RESTORE','Restore').then(function(t){if(t)api('/api/backup/restore',{name:b.name,confirmText:t}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok')})})};bb.appendChild(x)}
    d.appendChild(bb);box.appendChild(d);
  });
}
$('#bBkFull').onclick=function(){var b=this;b.disabled=true;api('/api/backup/full',{}).then(function(r){b.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok')})};
var watch=null;
function loadWatch(){api('/api/watch').then(function(r){if(r&&r.items){watch=r;renderWatch()}})}
function renderWatch(){
  var box=$('#watchlist');box.textContent='';
  $('#watchwhen').textContent=watch.lastCheck?'checked '+new Date(watch.lastCheck).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'not checked yet';
  if(!watch.items.length)box.appendChild(el('div','dim','Nothing checked yet - press Check now.'));
  watch.items.forEach(function(it){
    var d=el('div','upk'),h=el('div','h');h.appendChild(el('b','',it.label));
    var lab={update:'UPDATE AVAILABLE',current:'up to date',error:'check failed',unknown:'unknown'}[it.status]||it.status;
    h.appendChild(el('span',it.status==='update'?'warn':it.status==='current'?'ok':it.status==='error'?'bad':'dim',lab));d.appendChild(h);
    d.appendChild(el('div','m dim','yours: '+(it.installed||'?')+'   newest: '+(it.latest||'?')));
    if(it.note)d.appendChild(el('div','m '+(it.status==='error'?'bad':'dim'),it.note));
    var bb=el('div','bb');
    if(it.url){var a=el('a','','Open page');a.href=it.url;a.target='_blank';a.rel='noopener noreferrer';bb.appendChild(a)}
    if(it.canMark&&it.status!=='current'){var m=el('button','','Mark as installed');m.onclick=function(){api('/api/watch/installed',{id:it.id}).then(function(r){if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok');loadWatch()})};bb.appendChild(m)}
    if(it.removable){var rm=el('button','','Stop watching');rm.onclick=function(){api('/api/watch/remove',{id:it.id}).then(function(){loadWatch()})};bb.appendChild(rm)}
    d.appendChild(bb);box.appendChild(d);
  });
  if(document.activeElement!==$('#watchHrs')){$('#watchHrs').value=watch.everyHours}
  $('#watchOn').checked=!!watch.enabled;
  if(state){state.watch={count:watch.count,lastCheck:watch.lastCheck};pill()}
}
$('#bWatchCheck').onclick=function(){var b=this;b.disabled=true;api('/api/watch/check',{}).then(function(r){b.disabled=false;if(r.ok===false)toast(r.error,'bad');else toast(r.note,'ok');loadWatch()})};
$('#bWatchAdd').onclick=function(){var v=$('#watchRepo').value.trim();if(!v)return;api('/api/watch/add',{repo:v,label:$('#watchLabel').value}).then(function(r){if(r.ok===false)toast(r.error,'bad');else{toast(r.note,'ok');$('#watchRepo').value='';$('#watchLabel').value=''}setTimeout(loadWatch,2500)})};
$('#watchOn').onchange=function(){api('/api/watch/set',{enabled:this.checked})};
$('#watchHrs').onchange=function(){api('/api/watch/set',{everyHours:this.value}).then(function(r){if(r.ok===false){toast(r.error,'bad');loadWatch()}})};
$('#bUpdRefresh').onclick=loadUpd;
/* ---------------- VPS ---------------- */
var vinfo=null, vplan=null, vlogPos=-1, vlogBusy=false, vcfgSig='';
function vapi(name,body){return api('/api/vps/'+name,body===undefined?{}:body)}
var vcmdId=0;
function vcmdLine(t,c){var b=$('#vcmdOut');b.appendChild(el('div','ln '+(c||''),t));b.scrollTop=b.scrollHeight;while(b.childNodes.length>1500)b.removeChild(b.firstChild)}
function vcmdOpen(id,label){vcmdId=id;$('#vcmdT').textContent=label;var s=$('#vcmdSt');s.textContent='running ...';s.style.color='';$('#vcmdOut').textContent='';$('#vcmdStop').style.display='';vcmdLine('> '+label,'dash');var d=$('#vcmd');if(!d.open)d.showModal()}
function vcmdEnd(code){var ok=code===0;vcmdLine(ok?'[ok] finished':'[exit '+code+'] finished',ok?'dash':'error');var s=$('#vcmdSt');s.textContent=ok?'Finished.':'Failed (exit '+code+').';s.style.color=ok?'var(--cy)':'var(--bad)';$('#vcmdStop').style.display='none';vcmdId=0}
$('#vcmdX').onclick=function(){$('#vcmd').close()};
$('#vcmdStop').onclick=function(){if(vcmdId)api('/api/job/cancel',{key:'a'+vcmdId}).then(function(r){if(r&&r.ok===false)toast(r.error||'Could not stop it','bad')})};
$('#vcmdCopy').onclick=function(){var t=$('#vcmdOut').innerText;try{navigator.clipboard.writeText(t).then(function(){toast('Output copied','ok')},function(){toast('Could not copy','bad')})}catch(e){toast('Could not copy','bad')}};
function vout(t,c){var b=$('#vpsout');b.appendChild(el('div','ln '+(c||''),t));b.scrollTop=b.scrollHeight;while(b.childNodes.length>800)b.removeChild(b.firstChild)}
function loadVps(){api('/api/vps/info').then(function(r){if(r&&r.ok){vinfo=r;renderVpsPage()}});if(typeof ghLoad==='function')ghLoad()}
function vtoast(r,okMsg){ if(r&&r.ok===false) toast(r.error||'failed','bad'); else toast((r&&r.note)||okMsg||'Done','ok') }
function renderVps(){
  var v=state&&state.vps; if(!v) return;
  var s=v.state||'unknown';
  $('#vpill').className='pill '+s;$('#vpilltxt').textContent='VPS '+s.toUpperCase();
  $('#bVpsStart').disabled=(s==='online'||s==='starting'||s==='stopping');
  $('#bVpsStop').disabled=(s==='offline'||s==='stopping');
  if(state.mode==='vps'){document.title='VNR - CyberPunk Server Panel Lite';$('#sub').textContent='VPS mode - '+v.host}
  var t=$('#vpstiles');t.textContent='';
  function tile(k,val,c){var d=el('div','tile '+(c||''));d.appendChild(el('div','k',k));d.appendChild(el('div','v',val));t.appendChild(d)}
  tile('VPS server',s.toUpperCase(),s==='online'?'ok':s==='offline'?'bad':'warn');
  if(v.running){tile('Up',fmtUp(v.startedAt).replace('up ',''),'ok');tile('PID',(v.pids||[]).join(', '),'')}
  tile('Game UDP',v.gameUdp===null?'-':v.gameUdp?'listening':'not listening',v.gameUdp?'ok':v.gameUdp===false?'bad':'');
  tile('Downloads TCP',v.downloadPortUp?'reachable from here':(v.downloadTcp?'listening on VPS':'closed'),v.downloadPortUp?'ok':v.downloadTcp?'warn':'');
  tile('Database',v.dbTcp===null?'-':v.dbTcp?'listening':'down',v.dbTcp?'ok':v.dbTcp===false?'bad':'');
  tile('Free disk',v.freeGB==null?'-':v.freeGB+' GB',v.freeGB!=null&&v.freeGB<2?'bad':v.freeGB!=null&&v.freeGB<5?'warn':'');
  if(v.lastExit)tile('Last exit','code '+v.lastExit.code+(v.lastExit.stopped?' (stopped here)':''),v.lastExit.code===0||v.lastExit.stopped?'':'warn');
  var vt2=$('#vatiles');if(vt2)vt2.innerHTML=t.innerHTML;
  var kv=$('#vpskv');kv.textContent='';
  function row(k,val,c){kv.appendChild(el('span','',k));kv.appendChild(el('span',c||'',val))}
  row('OpenSSH client',v.sshFound?'found':'NOT FOUND',v.sshFound?'ok':'bad');
  row('User',v.user||'not set yet',v.user?'ok':'bad');
  row('SSH key',v.keyExists?'created':'none yet',v.keyExists?'ok':'bad');
  row('Host key',v.hostPinned?'trusted (pinned)':'not trusted yet',v.hostPinned?'ok':'bad');
  row('Last contact',v.statusAt?new Date(v.statusAt).toLocaleTimeString():'never',v.error?'bad':'');
  if(v.error)row('Problem',v.error,'bad');
  $('#vpsconn').textContent=v.user?('Connected as '+v.user+'@'+v.host):v.host;
  renderWizard();
}
function renderVpsPage(){
  if(!vinfo)return;var c=vinfo.config;
  var sig=JSON.stringify(c);
  if(sig!==vcfgSig && !['vf_host','vf_user','vf_port','vf_root','vf_pub','vf_key'].some(function(i){return document.activeElement&&document.activeElement.id===i})){
    vcfgSig=sig;$('#vf_host').value=c.host||'';$('#vf_user').value=c.user||'';$('#vf_port').value=c.sshPort||22;$('#vf_root').value=c.remoteRoot||'';$('#vf_pub').value=c.publicIp||'';$('#vf_key').value=c.identityFile||'';$('#vf_key').placeholder=c.keyFile||'';
  }
  var g=$('#vgroups');
  if(g.dataset.sig!==JSON.stringify(c.groups)){
    g.dataset.sig=JSON.stringify(c.groups);g.textContent='';
    c.groups.forEach(function(x){var l=el('label','gchk'+(x.warn?' warn':''));var i=el('input');i.type='checkbox';i.checked=!!x.default;i.dataset.id=x.id;l.appendChild(i);l.appendChild(el('span','',x.label));g.appendChild(l)});
  }
  var ch=$('#vpschecks');ch.textContent='';
  var list=vinfo.doctor;
  if(!list||!list.length){ch.appendChild(el('div','dim','Press "Check VPS".'))}
  else list.forEach(function(x){var d=el('div','chk');d.appendChild(el('span','b '+x.state,x.state==='ok'?'OK':x.state==='warn'?'WARN':'FAIL'));d.appendChild(el('span','',x.label+(x.detail?' - '+x.detail:'')));if(x.fix&&x.state!=='ok')d.appendChild(el('span','f','Fix: '+x.fix));ch.appendChild(d)});
  $('#vchkwhen').textContent=vinfo.doctorAt?new Date(vinfo.doctorAt).toLocaleTimeString():'';
  renderWizard();
}
function vsave(){ return vapi('config',{host:$('#vf_host').value,user:$('#vf_user').value,sshPort:$('#vf_port').value,remoteRoot:$('#vf_root').value,publicIp:$('#vf_pub').value,identityFile:$('#vf_key').value}).then(function(r){vtoast(r,'Saved');vcfgSig='';loadVps();return r}) }
$('#vSave').onclick=vsave;
$('#vKey').onclick=function(){vapi('keygen').then(function(r){if(r.ok===false){toast(r.error,'bad');return}$('#vkeybox').hidden=false;$('#vkeytxt').value=r.publicKey;toast('Key ready. The pack already carries it; nothing to paste.','ok');loadVps()})};
$('#vKeyCopy').onclick=function(){navigator.clipboard.writeText($('#vkeytxt').value).then(function(){toast('Public key copied','ok')},function(){$('#vkeytxt').select();toast('Select and copy it by hand','warn')})};
$('#vTrust').onclick=function(){vapi('hostkey').then(function(r){if(r.ok===false){toast(r.error,'bad');return}$('#vtrustbox').hidden=false;$('#vfp').textContent=r.fingerprint;$('#vfpin').value='';$('#vfpin').focus();if(r.pinned)toast('A key is already trusted for this VPS; trusting replaces it.','warn')})};
$('#vTrustNo').onclick=function(){$('#vtrustbox').hidden=true};
$('#vTrustGo').onclick=function(){var f=$('#vfpin').value.trim();vapi('hostkey.trust',{fingerprint:f}).then(function(r){vtoast(r,'Host key trusted');if(r.ok!==false){$('#vtrustbox').hidden=true;vapi('refresh').then(loadVps)}})};
$('#vForget').onclick=function(){dlg('Forget the VPS host key?','The next connection will need you to trust the key again. Only do this if you reinstalled the VPS.',null,'Forget').then(function(v){if(v)vapi('hostkey.forget').then(function(r){vtoast(r,'Forgotten');loadVps()})})};
function vact(name,label){return vapi(name).then(function(r){vtoast(r,label+' done');loadVps();return r})}
$('#vStart').onclick=function(){vact('start','Start')};
$('#bVpsStart').onclick=function(){vact('start','Start')};
$('#bVpsStop').onclick=function(){dlg('Stop the server on the VPS?','Players are disconnected. The server is asked to shut down cleanly first (Ctrl+C), and only forced if that does not work.',null,'Stop VPS').then(function(v){if(v)vact('stop','Stop')})};
$('#bVpsEmerg').onclick=function(){var b=$('#bVpsEmerg');if(b.disabled)return;b.disabled=true;b.classList.add('busy');b.textContent='Killing ...';
  vapi('emergency').then(function(r){toast((r&&(r.note||r.error))||'Emergency stop sent to the VPS',r&&r.ok?'ok':'bad');loadVps()}).catch(function(){toast('Emergency stop: no answer from the launcher','bad')})
  .then(function(){b.disabled=false;b.classList.remove('busy');b.innerHTML='&#9888; Emergency VPS'})};
$('#vStop').onclick=function(){dlg('Stop the server on the VPS?','Players are disconnected. Ctrl+C is sent first; if the server does not accept it, it is forced and the result says so.',null,'Stop on VPS').then(function(v){if(v)vact('stop','Stop')})};
$('#vRestart').onclick=function(){dlg('Restart the server on the VPS?','Players are disconnected while it restarts.',null,'Restart on VPS').then(function(v){if(v)vact('restart','Restart')})};
$('#vRefresh').onclick=function(){vapi('refresh').then(function(r){if(r.summary&&r.summary.error)toast(r.summary.error,'bad');else toast('Refreshed','ok');loadVps()})};
$('#vCheck').onclick=function(){vact('probe','Check')};
$('#vCfg').onclick=function(){vact('checkconfig','Check')};
$('#vDb').onclick=function(){vact('dbtables','Database')};
$('#vScripts').onclick=function(){vact('scripts','Update')};
$('#vPack').onclick=function(){vapi('pack').then(function(r){vtoast(r,'Pack ready');if(r.ok!==false){vout('VPS pack folder: '+r.dir,'dash');if(r.publicKey){$('#vkeybox').hidden=false;$('#vkeytxt').value=r.publicKey}}})};
function vgroupIds(){var a=[];document.querySelectorAll('#vgroups input').forEach(function(i){if(i.checked)a.push(i.dataset.id)});return a}
$('#vPlan').onclick=function(){$('#vSend').disabled=true;vplan=null;$('#vplan').textContent='Comparing ...';vapi('deploy.plan',{groups:vgroupIds()}).then(function(r){
  if(r.ok===false){$('#vplan').textContent=r.error;toast(r.error,'bad');return}
  vplan=r;var n=r.counts;$('#vplan').textContent=n.add+' new, '+n.change+' changed, '+n.same+' identical'+(n.heldBack?', '+n.heldBack+' held back (look like live data)':'')+(n.extra?', '+n.extra+' only on the VPS (kept)':'');
  $('#vSend').disabled=!(n.add+n.change)}) };
$('#vSend').onclick=function(){if(!vplan)return;var n=vplan.counts;dlg('Send '+(n.add+n.change)+' file(s) to the VPS?','The '+n.change+' file(s) that will be replaced are backed up on the VPS first, then all are verified.'+(vplan.needsStopped?' The server on the VPS must be stopped.':''),null,'Send').then(function(v){if(!v)return;$('#vSend').disabled=true;vapi('deploy.apply',{planId:vplan.planId}).then(function(r){vtoast(r,'Sent');vplan=null;$('#vplan').textContent=r.ok===false?r.error:r.note})})};
function vlogTick(){
  if(!$('#vLive').checked||vlogBusy||curPage!=='vps')return;vlogBusy=true;
  vapi('logs',{pos:vlogPos}).then(function(r){vlogBusy=false;
    if(!r||r.ok===false){if(r&&r.error&&!$('#vlog').dataset.err){$('#vlog').dataset.err='1';$('#vlog').appendChild(el('div','ln error',r.error))}return}
    $('#vlog').dataset.err='';var b=$('#vlog');if(r.reset){b.textContent=''}
    vlogPos=r.pos;if(r.text){r.text.split('\n').forEach(function(l){if(l.trim())b.appendChild(el('div','ln '+(/\b(error|fail|fatal|exception|crash)/i.test(l)?'error':/\bwarn/i.test(l)?'warn':''),l))});while(b.childNodes.length>1500)b.removeChild(b.firstChild);b.scrollTop=b.scrollHeight}
  });
}
$('#vLive').onchange=function(){if($('#vLive').checked){vlogPos=-1;$('#vlog').textContent='';vlogTick()}};
setInterval(vlogTick,4000);

var vtab='status';
function vshowTab(t){vtab=t;document.querySelectorAll('.vtab').forEach(function(b){b.classList.toggle('on',b.dataset.t===t)});document.querySelectorAll('.vpane').forEach(function(p){p.classList.toggle('on',p.dataset.t===t)})}
document.querySelectorAll('.vtab').forEach(function(b){b.onclick=function(){vshowTab(b.dataset.t)}});
function vstep(n,state,badge){var a=$('#vs'+n);a.dataset.state=state;$('#vb'+n).textContent=badge}
function renderWizard(){
  var w=vinfo&&vinfo.wizard; if(!w)return;
  var v=(state&&state.vps)||{};
  var ready=w.hasUser&&w.hasKey;
  // step 1
  if(!w.hasUser){vstep(1,'bad','NEEDS SETTINGS');$('#vt1').innerHTML='Enter the VPS address and your Windows user under <b>Settings</b> first.'}
  else if(w.packAt){vstep(1,'done','PACK READY');$('#vt1').innerHTML='Pack made at '+new Date(w.packAt).toLocaleString()+' &middot; '+(w.packDb?'<span class="ok">your database is included</span>':'<span class="warn">database not included</span>')+'.<br>Copy the whole folder to the VPS (step 2).'}
  else {vstep(1,'doing','TO DO');$('#vt1').innerHTML='Makes the folder you copy to the VPS: setup scripts, your SSH key, the game tables and <b>a fresh export of your database</b>. No password or licence key goes in it.'}
  // step 2
  var live=$('#vlive2');
  if(!w.packAt){vstep(2,'locked','LOCKED');live.className='vlive';live.lastChild.textContent='prepare the pack first'}
  else if(w.portUp){vstep(2,'done','VPS ANSWERS');live.className='vlive up';live.lastChild.textContent='SSH is answering - setup has run'}
  else {vstep(2,'doing','WAITING FOR VPS');live.className='vlive wait';live.lastChild.textContent='waiting for the VPS'}
  // step 3
  var checked=w.doctorCount>0, clean=checked&&w.doctorBad===0;
  $('#vfpwrap').style.display=w.pinned?'none':'';
  if(!w.portUp){vstep(3,'locked','LOCKED')}
  else if(clean&&w.pinned){vstep(3,'done',v.state==='online'?'SERVER ONLINE':'READY TO START')}
  else if(checked&&w.doctorBad>0){vstep(3,'bad',w.doctorBad+' PROBLEM'+(w.doctorBad>1?'S':''))}
  else vstep(3,'doing','READY');
  $('#vFinish').disabled=!w.portUp||vBusy;
  $('#vGo').disabled=!(clean&&w.pinned)||v.state==='online'||v.state==='starting';
  $('#vStopMain').disabled=!(v.state==='online'||v.state==='starting');
}
var vBusy=false;
function vsteplist(steps){var f=$('#vfin');f.textContent='';(steps||[]).forEach(function(x){f.appendChild(el('div',x.ok?'ok':'bad',(x.ok?'✓ ':'✗ ')+x.name+(x.detail?' - '+x.detail:'')))})}
$('#vPrepare').onclick=function(){
  $('#vPrepare').disabled=true;vout('Preparing the pack ...','dash');
  vapi('prepare',{withDb:$('#vWithDb').checked}).then(function(r){
    $('#vPrepare').disabled=false;if(r&&r.ok!==false&&$('#vWithDb').checked&&!r.dbIncluded)toast('Pack ready, but WITHOUT your database: '+(r.dbError||'no dump found'),'warn');else vtoast(r,'Pack ready');
    if(r&&r.ok!==false){vout('VPS pack folder: '+r.dir,'dash');if(!r.dbIncluded&&r.dbError)vout(r.dbError,'warn')}
    else if(r&&r.error)vout(r.error,'error');
    loadVps();
  });
};
$('#vOpenPack').onclick=function(){vapi('openpack').then(function(r){if(r&&r.ok===false)toast(r.error,'bad')})};
$('#vCopyPath').onclick=function(){var pth=(vinfo&&vinfo.wizard&&vinfo.wizard.packDir)||'';navigator.clipboard.writeText(pth).then(function(){toast('Path copied: '+pth,'ok')},function(){toast(pth,'warn')})};
$('#vRecheck').onclick=function(){vapi('refresh').then(function(){loadVps()})};
$('#vPaste').onclick=function(){navigator.clipboard.readText().then(function(t){$('#vfpmain').value=(t||'').trim()},function(){toast('The browser did not allow reading the clipboard. Press Ctrl+V in the box.','warn')})};
$('#vFinish').onclick=function(){
  var w=vinfo&&vinfo.wizard||{};
  function go(fp){
    vBusy=true;$('#vFinish').disabled=true;$('#vfin').textContent='Working ... (details in the Output tab)';
    vapi('finish',{fingerprint:fp}).then(function(r){
      vBusy=false;vsteplist(r&&r.steps);vtoast(r,'Install finished');loadVps();
      if(r&&r.ok===false&&r.error)vout(r.error,'error');
      if(r&&r.ok!==false)vshowTab('status');else vshowTab('checks');
    });
  }
  var fp=$('#vfpmain').value.trim();
  if(w.pinned||fp){go(fp);return}
  navigator.clipboard.readText().then(function(t){t=(t||'').trim();if(/^SHA256:/.test(t)){$('#vfpmain').value=t;go(t)}else toast('Paste the host fingerprint from the VPS first (it starts with SHA256:).','warn')},function(){toast('Paste the host fingerprint from the VPS into the box first.','warn')});
};
$('#vGo').onclick=function(){vact('start','Start')};
$('#vStopMain').onclick=function(){$('#vStop').click()};
setInterval(function(){if(curPage==='vps')loadVps()},5000);

var PST=['done','testing','doing','todo'];
var PLABEL={done:'Done',testing:'Testing',doing:'In progress',todo:'To do'};
function pChip(st){var c=el('span','pchip pc-'+st,PLABEL[st]||st);return c}
function pSel(it){
  var sel=el('select');sel.setAttribute('aria-label','Status of '+it.title);
  PST.slice().reverse().forEach(function(v){var o=el('option','',PLABEL[v]);o.value=v;if(v===it.status)o.selected=true;sel.appendChild(o)});
  sel.onchange=function(){api('/api/progress',{id:it.id,status:sel.value}).then(function(r){if(r.ok===false)toast(r.error,'bad')})};return sel;
}
function pBar(list){
  var b=el('div','pmini');var n=list.length||1;
  PST.forEach(function(k){var c=list.filter(function(x){return x.status===k}).length;if(c){var i=el('i','s-'+k);i.style.width=(c/n*100)+'%';i.title=PLABEL[k]+': '+c;b.appendChild(i)}});return b;
}
function renderProgress(){
  var items=state.progress||[],pr=$('#progress');if(!pr)return;
  var sig=JSON.stringify(items);if(pr.dataset.sig===sig)return;pr.dataset.sig=sig;pr.textContent='';
  var steps=items.filter(function(x){return x.step>0}).sort(function(a,b){return a.step-b.step});
  var kids=function(id){return items.filter(function(x){return x.parent===id})};
  var sys=items.filter(function(x){return !(x.step>0)&&!x.parent});
  // header: status mix of the six steps
  var cnt={done:0,testing:0,doing:0,todo:0};steps.forEach(function(it){cnt[it.status]=(cnt[it.status]||0)+1});
  var bar=$('#progbar');bar.textContent='';
  PST.forEach(function(k){if(cnt[k]){var i=el('i','s-'+k);i.style.width=(cnt[k]/(steps.length||1)*100)+'%';i.title=PLABEL[k]+': '+cnt[k];bar.appendChild(i)}});
  $('#progcount').textContent='('+cnt.done+' of '+steps.length+' steps done)';
  var lg=$('#progleg');lg.textContent='';
  PST.forEach(function(k){lg.appendChild(el('span','s-'+k,PLABEL[k]+' '+(cnt[k]||0)))});
  // pipeline
  var pp=$('#progpipe');pp.textContent='';
  steps.forEach(function(it){
    var li=el('li','pn pn-'+it.status);li.appendChild(el('b','pnum',String(it.step)));
    var t=el('div','pnt');t.appendChild(el('span','pnn',it.title.replace(/^\d+\.\s*/,'')));t.appendChild(pChip(it.status));li.appendChild(t);
    li.onclick=function(){var c=document.getElementById('pc_'+it.id);if(c){c.open=true;c.scrollIntoView({behavior:'smooth',block:'center'})}};
    pp.appendChild(li);
  });
  // detail cards
  steps.forEach(function(it){
    var ch=kids(it.id);
    var d=el('details','pcard pk-'+it.status);d.id='pc_'+it.id;if(it.status==='doing'||it.status==='testing')d.open=true;
    var sm=el('summary','');
    sm.appendChild(el('b','pnum',String(it.step)));
    var tt=el('div','ptt');tt.appendChild(el('div','pttl',it.title.replace(/^\d+\.\s*/,'')));
    var meta=[];if(ch.length)meta.push(ch.filter(function(x){return x.status==='done'}).length+' of '+ch.length+' parts done');if(it.updated)meta.push('updated '+it.updated);
    if(meta.length)tt.appendChild(el('div','pmeta dim',meta.join('  /  ')));
    sm.appendChild(tt);sm.appendChild(pChip(it.status));d.appendChild(sm);
    var body=el('div','pbody');
    if(it.note)body.appendChild(el('p','pnote',it.note));
    if(it.evidence){var e=el('div','pev');e.appendChild(el('span','plab','EVIDENCE'));e.appendChild(el('span','',it.evidence));body.appendChild(e)}
    if(it.left&&it.left.length){var l=el('div','pleft');l.appendChild(el('span','plab','STILL TO DO'));var u=el('ul','');it.left.forEach(function(x){u.appendChild(el('li','',x))});l.appendChild(u);body.appendChild(l)}
    if(ch.length){
      body.appendChild(pBar(ch));
      var cl=el('div','pkids');
      ch.forEach(function(c){
        var r=el('div','pkid');var h=el('div','pkh');h.appendChild(el('span','pkt',c.title));h.appendChild(pChip(c.status));h.appendChild(pSel(c));r.appendChild(h);
        if(c.note)r.appendChild(el('div','n dim',c.note));cl.appendChild(r);
      });body.appendChild(cl);
    }
    var ft=el('div','pfoot');ft.appendChild(el('span','dim','Set status'));ft.appendChild(pSel(it));body.appendChild(ft);
    d.appendChild(body);pr.appendChild(d);
  });
  // systems and tools: one compact table
  var sb=$('#progsysbody');sb.textContent='';$('#progsyscount').textContent='('+sys.filter(function(x){return x.status==='done'}).length+' of '+sys.length+' done)';
  var grp='';
  sys.forEach(function(it){
    if(it.group&&it.group!==grp){grp=it.group;sb.appendChild(el('div','psg',grp))}
    var r=el('div','psrow pk-'+it.status);
    var a=el('div','psmain');a.appendChild(el('div','pst',it.title));if(it.note)a.appendChild(el('div','psn dim',it.note));r.appendChild(a);
    var b=el('div','psctl');b.appendChild(pChip(it.status));b.appendChild(pSel(it));r.appendChild(b);sb.appendChild(r);
  });
}
var recent=[];
function recentDraw(){
  var b=$('#recent');if(!b)return;b.textContent='';
  if(!recent.length){b.appendChild(el('div','dim','Nothing yet. Updates, backups, restarts and edits show up here.'));return}
  recent.slice(-6).reverse().forEach(function(e){
    var d=el('div','rr'+(e.ok===false?' bad':''));
    d.appendChild(el('span','dim',new Date(e.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})));
    d.appendChild(el('span','d',(e.ok===false?'FAILED - ':'')+e.detail));b.appendChild(d);
  });
}
$('#bAllChg').onclick=function(){showPage('console');showTab('chg')};
api('/api/changes').then(function(r){recent=(r||[]).slice(-40);recentDraw()});
/* ---------------- progress dock: reactive bars with real Stop buttons ---------------- */
var pitems={},ptitle=document.title,ptick=null;
function pSecs(p){return Math.max(0,Math.round((Date.now()-p.t)/1000))+' s'}
function pFmtSec(s){s=Math.max(0,Math.round(s));var m=s/60|0;return m?m+'m '+(s%60)+'s':s+'s'}
function pFmtRate(r,unit){if(unit==='bytes')return (r>=1048576?(r/1048576).toFixed(1)+' MB':Math.max(1,Math.round(r/1024))+' KB')+'/s';return (r>=10?Math.round(r):r.toFixed(1))+' '+(unit||'items')+'/s'}
function pStopLabel(p){return p.kind==='start'?'Cancel start':p.kind==='stop'?'Force stop':'Stop'}
function pEl(p){
  var d=pitems[p.key];if(d&&!d.e.isConnected){d.e.remove();delete pitems[p.key];d=null}if(d)return d;
  var e=el('div','pi'),h=el('div','ph'),l=el('div','pl1'),sx=el('button','psx','■ Stop'),x=el('button','px','✕');
  sx.type='button';x.type='button';x.title='hide';x.setAttribute('aria-label','hide this message');x.hidden=true;
  x.onclick=function(){e.remove();delete pitems[p.key];pSummary()};
  sx.onclick=function(){
    if(sx.disabled)return;var dd=pitems[p.key];sx.disabled=true;sx.textContent='Stopping…';
    api('/api/job/cancel',{key:p.key}).then(function(r){
      if(r&&r.ok===false){toast(r.error||'Could not stop it','bad');if(dd&&!dd.done){sx.disabled=false;sx.textContent='■ '+pStopLabel(dd.p)}}
    });
  };
  h.appendChild(l);h.appendChild(sx);h.appendChild(x);
  var st=el('div','ps'),bar=el('div','pbar ind'),bi=el('i'),n=el('div','pn'),n1=el('span'),n2=el('span'),mt=el('div','pm');
  bar.appendChild(bi);n.appendChild(n1);n.appendChild(n2);e.appendChild(h);e.appendChild(st);e.appendChild(bar);e.appendChild(n);e.appendChild(mt);
  $('#prog').appendChild(e);d=pitems[p.key]={e:e,l:l,st:st,bar:bar,bi:bi,n1:n1,n2:n2,mt:mt,sx:sx,x:x,p:p,done:false,hist:[]};
  if(!ptick)ptick=setInterval(pTick,1000);return d;
}
function pDraw(d){
  var p=d.p;d.l.textContent=p.label;
  var stage=(p.steps?'Step '+(p.step||1)+' of '+p.steps+(p.stage?' - ':''):'')+(p.stage||'');
  if(p.total>0){
    var pc=Math.min(100,Math.round(p.done/p.total*100));d.bar.classList.remove('ind');d.bi.style.width=pc+'%';
    d.st.textContent=stage+(p.unit!=='bytes'&&p.text?(stage?' - ':'')+p.text:'');
    d.n1.textContent=p.unit==='bytes'?(p.text||''):p.done+' / '+p.total+(p.unit?' '+p.unit:'');
    d.n2.textContent=pc+'%  -  '+pSecs(p);
  }else{
    d.bar.classList.add('ind');d.bi.style.width='';d.st.textContent=stage||p.text||'Working ...';d.n1.textContent=stage?(p.text||''):'';d.n2.textContent=pSecs(p);
  }
  d.e.classList.toggle('pi-stopping',!!p.stopping);
  var parts=[];if(p.actor)parts.push('by '+p.actor);
  if(p.total>0){
    var now=Date.now(),h=d.hist;
    if(!h.length||h[h.length-1].done!==p.done)h.push({t:now,done:p.done});
    while(h.length>2&&now-h[0].t>6000)h.shift();
    if(h.length>1){var dt=(h[h.length-1].t-h[0].t)/1000,dd=h[h.length-1].done-h[0].done;
      if(dt>0.4&&dd>0){var rate=dd/dt;parts.push(pFmtRate(rate,p.unit));var left=(p.total-p.done)/rate;if(left>=1&&now-p.t>2000)parts.push('~'+pFmtSec(left)+' left')}}
  }
  d.mt.textContent=parts.join('  ·  ');
  if(p.stopping){d.sx.disabled=true;d.sx.textContent='Stopping…';d.sx.title='Waiting for the current step to end'}
  else if(p.stoppable===false){d.sx.disabled=true;d.sx.textContent='Finishing…';d.sx.title=p.stopNote||'This step cannot be stopped safely';if(p.stopNote)d.mt.textContent=p.stopNote}
  else{d.sx.disabled=false;d.sx.textContent='■ '+pStopLabel(p);d.sx.title='Stop this job now'}
  d.sx.hidden=false;
  pSummary();
}
function pSummary(){
  var run=0,det=0,sum=0;
  Object.keys(pitems).forEach(function(k){var d=pitems[k];if(!d.done&&d.e.isConnected){run++;if(d.p.total>0){det++;sum+=Math.min(1,d.p.done/d.p.total)}}});
  var g=$('#gbar');g.className=run?(det===run?'on':'on ind'):'';g.firstChild.style.width=(run&&det===run)?Math.round(sum/det*100)+'%':'';
  var b=$('#bStopAll');b.hidden=!run;b.textContent='■ Stop all'+(run>1?' ('+run+')':'');
  document.body.classList.toggle('busyjobs',run>0);
}
function pTick(){var any=false;Object.keys(pitems).forEach(function(k){var d=pitems[k];if(!d.done){any=true;var p=d.p;d.n2.textContent=(p.total>0?Math.min(100,Math.round(p.done/p.total*100))+'%  -  ':'')+pSecs(p)}});if(!any){clearInterval(ptick);ptick=null}}
function pEv(ev,p){
  var old=pitems[p.key];if(old&&old.done&&ev!=='end'){old.e.remove();delete pitems[p.key]}
  var d=pEl(p);d.p=p;
  if(ev==='end'){
    d.done=true;['pi-ok','pi-bad','pi-stop','pi-stopping'].forEach(function(c){d.e.classList.remove(c)});
    d.e.classList.add(p.stopped?'pi-stop':p.ok?'pi-ok':'pi-bad');d.bar.classList.remove('ind');d.bi.style.width='100%';
    d.l.textContent=(p.stopped?'■ Stopped: ':p.ok?'✔ ':'✖ ')+p.label;d.st.textContent=p.text||(p.ok?'Done':'Failed');d.n1.textContent='took '+p.secs+' s';d.n2.textContent='';
    d.mt.textContent=p.actor?'by '+p.actor:'';d.sx.hidden=true;d.x.hidden=false;
    setTimeout(function(){if(pitems[p.key]===d&&d.e.parentNode){d.e.remove();delete pitems[p.key];pSummary()}},p.ok?20000:p.stopped?30000:0||600000);
    if(document.hidden)document.title=(p.stopped?'■ ':p.ok?'✔ ':'✖ ')+ptitle;
    pSummary();
  }else pDraw(d);
}
document.addEventListener('visibilitychange',function(){if(!document.hidden)document.title=ptitle});
$('#bEmerg').onclick=function(){var b=$('#bEmerg');if(b.disabled)return;b.disabled=true;b.classList.add('busy');b.textContent='Killing ...';
  api('/api/emergency',{}).then(function(r){toast((r&&(r.note||r.error))||'Emergency stop sent',r&&r.ok?'ok':'bad')}).catch(function(){toast('Emergency stop: no answer from the launcher','bad')})
  .then(function(){b.disabled=false;b.classList.remove('busy');b.innerHTML='&#9888; Emergency stop'})};
$('#bStopAll').onclick=function(){var b=$('#bStopAll');b.disabled=true;api('/api/job/cancelall',{}).then(function(r){b.disabled=false;if(r&&r.ok===false)toast(r.error||'Could not stop','bad');else toast((r&&r.note)||'Stopping ...',r&&r.stopped?'ok':'warn');if(r&&r.refused&&r.refused.length)toast(r.refused[0],'warn')})};
/* ---------------- who is using the launcher ---------------- */
function whoShow(){var n=WHO||(state&&state.user)||'operator';$('#whoTxt').textContent=n}
$('#bWho').onclick=function(){var dl=$('#wdlg');$('#wname').value=WHO;dl.showModal();setTimeout(function(){$('#wname').focus()},30)};
$('#wno').onclick=function(){$('#wdlg').close()};
$('#wyes').onclick=function(){WHO=$('#wname').value.replace(/[^\p{L}\p{N} ._@-]/gu,'').trim().slice(0,40);try{localStorage.setItem('vnrWho',WHO)}catch(e){}whoShow();$('#wdlg').close();toast(WHO?'Commands are now logged as '+WHO:'Commands are logged under this PC user name','ok')};
$('#wname').addEventListener('keydown',function(e){if(e.key==='Enter')$('#wyes').click()});
/* ---------------- command log ---------------- */
var cl={rows:[],byId:{},who:'all',kind:'all',st:'all',q:'',open:{},shown:300,live:true,timer:0,loaded:false};
function clLoad(){api('/api/commands?limit=3000').then(function(r){if(r&&r.rows){cl.rows=r.rows;cl.byId={};r.rows.forEach(function(x){cl.byId[x.id]=x});cl.loaded=true;clDraw();clChips()}})}
function clMs(ms){if(ms==null)return '';if(ms<1000)return ms+' ms';var s=ms/1000;if(s<60)return s.toFixed(1)+' s';var m=s/60|0;return m+'m '+Math.round(s%60)+'s'}
function clTime(t){var d=new Date(t),p=function(n){return n<10?'0'+n:''+n},hm=p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());return d.toDateString()===new Date().toDateString()?hm:d.toLocaleDateString([], {month:'short',day:'numeric'})+' '+hm}
function clMatch(e){
  if(cl.who!=='all'&&e.actor.type!==cl.who)return false;
  if(cl.kind!=='all'){if(cl.kind==='request'&&e.kind!=='request')return false;if(cl.kind==='process'&&e.kind!=='process')return false}
  if(cl.st!=='all'&&e.status!==cl.st)return false;
  if(cl.q){var q=cl.q.toLowerCase();if(e.id===cl.q||e.parent===cl.q)return true;
    var hay=(e.action+' '+(e.detail||'')+' '+(e.cmd||'')+' '+e.actor.name+' '+e.actor.type+' '+(e.actor.via||'')+' '+(e.result||'')+' '+e.status+' '+e.kind+' '+(e.cwd||'')).toLowerCase();
    return hay.indexOf(q)>=0}
  return true;
}
var WICON={person:'◉',script:'⚙',system:'◇'};
function clRow(e){
  var d=el('div','clr st-'+e.status+' k-'+e.kind+(e.parent&&cl.byId[e.parent]?' child':'')),top=el('div','clt');
  top.appendChild(el('span','c-t',clTime(e.t)));
  var w=el('span','c-w');var wb=el('span','wb wb-'+e.actor.type);wb.appendChild(el('i','',WICON[e.actor.type]||'·'));wb.appendChild(document.createTextNode(e.actor.name));w.appendChild(wb);top.appendChild(w);
  var what=el('span','c-x');what.appendChild(el('b','',(e.kind==='process'?'▸ ':'')+e.action));
  var dd=e.kind==='process'?(e.cmd||''):(e.detail||'');if(dd)what.appendChild(el('span','d',dd));top.appendChild(what);
  var res=el('span','c-r');var chip=el('span','sc sc-'+e.status,e.status==='ok'?'OK':e.status==='failed'?'FAILED':e.status==='stopped'?'STOPPED':e.status==='running'?'RUNNING':'UNKNOWN');res.appendChild(chip);
  var meta=[];if(e.ms!=null)meta.push(clMs(e.ms));if(e.code!=null&&e.kind==='process')meta.push('exit '+e.code);if(meta.length)res.appendChild(el('span','m',meta.join(' · ')));top.appendChild(res);
  d.appendChild(top);
  if(cl.open[e.id])d.appendChild(clDetail(e));
  top.onclick=function(){if(cl.open[e.id])delete cl.open[e.id];else cl.open[e.id]=1;clDraw()};
  return d;
}
function clDetail(e){
  var b=el('div','cld'),dl=el('dl');
  function kv(k,v,mono){if(v==null||v==='')return;dl.appendChild(el('dt','',k));dl.appendChild(el('dd',mono?'mono':'',String(v)))}
  kv('Who',e.actor.name+'  ('+({person:'a person',script:'a script',system:'the launcher'}[e.actor.type]||e.actor.type)+')');
  kv('How it arrived',e.actor.via);
  if(e.actor.ip||e.actor.ua)kv('Client',(e.actor.ip||'')+(e.actor.ua?'  '+e.actor.ua:''));
  kv('Started',new Date(e.t).toLocaleString());
  if(e.ms!=null)kv('Took',clMs(e.ms));
  kv('Type',e.kind==='request'?'request (something asked for)':e.kind==='process'?'program the launcher started':e.kind==='session'?'session':e.kind);
  kv('What',e.action);kv('Details',e.detail);
  kv('Command line',e.cmd,true);kv('Working folder',e.cwd,true);
  if(e.code!=null)kv('Exit code',e.code);
  kv('Sent data',e.body,true);
  kv('Result / output',e.result,true);
  if(e.parent){var pe=cl.byId[e.parent];kv('Caused by',pe?pe.action+(pe.detail?' - '+pe.detail:'')+'  ['+pe.actor.name+']':e.parent)}
  kv('Entry id',e.id,true);
  b.appendChild(dl);
  var bt=el('div','cldb');
  if(e.cmd){var c1=el('button','','Copy command');c1.type='button';c1.onclick=function(ev){ev.stopPropagation();try{navigator.clipboard.writeText(e.cmd);toast('Command copied','ok')}catch(x){toast('Copy failed','bad')}};bt.appendChild(c1)}
  var c2=el('button','','Show the whole chain');c2.type='button';c2.onclick=function(ev){ev.stopPropagation();var id=e.parent||e.id;$('#clFind').value=id;cl.q=id;clDraw()};bt.appendChild(c2);
  b.appendChild(bt);return b;
}
function clChips(){
  var n=cl.rows.length,f=0,r=0,pe=0,sc=0;
  cl.rows.forEach(function(e){if(e.status==='failed')f++;if(e.status==='running')r++;if(e.actor.type==='person')pe++;else if(e.actor.type==='script')sc++});
  setChips('cmdlog',[['info','Entries',String(n)],[f?'bad':'ok','Failed',String(f)],[r?'warn':'ok','Running',String(r)],['info','By people',String(pe)],['info','By scripts',String(sc)]]);
  var nb=$('#nbCmd');if(nb){var recent=0,cut=Date.now()-3600000;cl.rows.forEach(function(e){if(e.status==='failed'&&e.t>cut)recent++});nb.hidden=!recent;nb.textContent=recent}
}
function clDraw(){
  var box=$('#cllist');if(!box)return;var keep=box.scrollTop;
  var rows=cl.rows.filter(clMatch).slice().reverse(),total=rows.length;box.textContent='';
  if(!total){box.appendChild(el('div','clempty',cl.rows.length?'Nothing matches these filters.':'No commands logged yet. Everything you do here, and everything a script does, shows up in this list.'));return}
  var f=document.createDocumentFragment();rows.slice(0,cl.shown).forEach(function(e){f.appendChild(clRow(e))});box.appendChild(f);
  if(total>cl.shown){var m=el('button','clmore','Show '+Math.min(300,total-cl.shown)+' older (of '+(total-cl.shown)+' more)');m.type='button';m.onclick=function(){cl.shown+=300;clDraw()};box.appendChild(m)}
  box.scrollTop=keep;
}
function clSched(){if(cl.timer)return;cl.timer=setTimeout(function(){cl.timer=0;if(curPage==='cmdlog')clDraw()},250)}
function clOnCmd(c){
  var old=cl.byId[c.id];
  if(old)Object.assign(old,c);else{cl.rows.push(c);cl.byId[c.id]=c;if(cl.rows.length>4000){var o=cl.rows.shift();delete cl.byId[o.id]}}
  clChips();if(curPage==='cmdlog'&&cl.live)clSched();
}
function clSeg(id,key){document.querySelectorAll('#'+id+' button').forEach(function(b){b.onclick=function(){cl[key]=b.dataset.v;document.querySelectorAll('#'+id+' button').forEach(function(x){x.classList.toggle('on',x===b)});cl.shown=300;clDraw()}})}
clSeg('clWho','who');clSeg('clKind','kind');clSeg('clSt','st');
$('#clFind').oninput=function(){cl.q=this.value.trim();cl.shown=300;clDraw()};
$('#clLive').onchange=function(){cl.live=this.checked;if(cl.live)clDraw()};
$('#clCsv').onclick=function(){window.location.href='/api/commands/export?fmt=csv'};
$('#clJson').onclick=function(){window.location.href='/api/commands/export?fmt=json'};
api('/api/commands?limit=3000').then(function(r){if(r&&r.rows){cl.rows=r.rows;cl.rows.forEach(function(x){cl.byId[x.id]=x});clChips();whoShow()}});
/* ---------------- VPS: one-button automatic setup ---------------- */
var vaState=null,vaNeedSig='';
var VA_ICON={pending:'○',running:'◐',waiting:'⏳',done:'✔',skipped:'–',failed:'✖'};
function vaPoll(){vapi('auto.status').then(function(r){if(r&&r.ok){vaState=r;vaRender()}})}
setInterval(function(){if(curPage==='vps')vaPoll()},1500);
function vaRender(){
  var r=vaState;if(!r)return;
  var v=r.vps||{},w=r.wizard||{};
  var ready=!!(w.hasUser&&w.pinned&&(v.state==='online'||v.state==='offline'));
  $('#vaGo').disabled=r.running;
  $('#vaGo').textContent=r.running?'Working ...':'Set up my VPS';
  $('#vaRepair').disabled=r.running||!ready;
  $('#vaRepair').title=ready?'Re-sends the scripts and changed files, repairs the database and the server, and checks everything.':'Available after the VPS has been set up once.';
  $('#vaCancel').hidden=!r.running;
  $('#vaDb').parentNode.hidden=ready||r.running;
  var needSet=!!(r.needs&&r.needs.type==='settings');
  $('#vaTitle').textContent=r.running?'Setting up your VPS':(needSet?'Set up my VPS':(r.resultOk===true?'Your VPS is ready':(r.resultOk===false&&r.startedAt?'The setup stopped':(ready?'Your VPS':'Set up my VPS'))));
  $('#vaSub').textContent=r.running?'Nothing else to press. If it needs something from you it says so right below.':(ready?'Re-checks everything, repairs what it can, sends changed files and makes sure the server runs.':'One button. It builds the installer, connects, trusts the VPS, sends the server files, creates and checks the database, starts the server and proves it works.');
  var ol=$('#vaPhases');ol.textContent='';
  (r.phases||[]).forEach(function(p){
    var li=el('li');li.dataset.s=p.state;li.appendChild(el('span','ic',VA_ICON[p.state]||'○'));li.appendChild(el('span','nm',p.label));
    if(p.detail)li.appendChild(el('span','dt',p.detail));ol.appendChild(li);
  });
  ol.hidden=!(r.running||r.startedAt)||needSet;
  vaNeed(r);
  var sm=$('#vaSummary');
  if(!r.running&&r.startedAt&&r.summary&&!needSet){sm.hidden=false;sm.className='vaSummary '+(r.resultOk?'ok':'bad');sm.textContent=r.summary}else sm.hidden=true;
  var cb=$('#vaChecks');
  var sig=JSON.stringify(r.checks||[]);
  if(cb.dataset.sig!==sig){
    cb.dataset.sig=sig;cb.textContent='';
    if(!(r.checks||[]).length){cb.appendChild(el('div','dim','The health report appears here after the setup has run. It covers the connection, the system, the database, the network and the server itself.'))}
    else{
      var cur='';
      r.checks.forEach(function(x){
        if(x.group!==cur){cur=x.group;cb.appendChild(el('div','vg',cur))}
        var d=el('div','vc');d.appendChild(el('span','b '+x.state,x.state==='ok'?'OK':x.state==='warn'?'WARN':'FAIL'));d.appendChild(el('span','t',x.label+(x.detail?' - '+x.detail:'')));
        if(x.fix&&x.state!=='ok')d.appendChild(el('span','f','Fix: '+x.fix));cb.appendChild(d);
      });
    }
    $('#vaChkWhen').textContent=r.endedAt?new Date(r.endedAt).toLocaleTimeString():'';
  }
}
function vaNeed(r){
  var n=r.needs,box=$('#vaNeed');
  var sig=JSON.stringify(n||null);
  if(!n||!r.running&&n.type!=='settings'){box.hidden=true;vaNeedSig='';box.textContent='';return}
  if(sig===vaNeedSig)return;   // keep what the user is typing
  vaNeedSig=sig;box.hidden=false;box.textContent='';
  if(n.type==='settings'){
    box.appendChild(el('h4','','The VPS address and user are needed first'));
    var c=r.config||{};
    var row=el('div','row'),h=el('input'),u=el('input');h.type='text';u.type='text';h.id='vaHost';u.id='vaUser';h.placeholder='VPS address';u.placeholder='Windows user (usually Administrator)';h.value=c.host||'';u.value=c.user||'';
    var b=el('button','go','Save and start');b.type='button';
    b.onclick=function(){vapi('config',{host:h.value,user:u.value}).then(function(x){if(x&&x.ok===false){toast(x.error,'bad');return}vapi('auto.start',{withDb:$('#vaDb').checked}).then(vaPoll)})};
    row.appendChild(h);row.appendChild(u);row.appendChild(b);box.appendChild(row);
  }else if(n.type==='installer'){
    box.appendChild(el('h4','','One thing to do on the VPS (once)'));
    if(n.reason)box.appendChild(el('div','dim',n.reason));
    var ol=el('ol');
    ['Open the installer folder (button below) and copy the file VNR_VPS_Installer.bat.','On the VPS, over RDP, paste it anywhere (for example the desktop) and double-click it. Accept the administrator prompt.','Leave it running until it says it is finished. This page notices by itself and carries on.'].forEach(function(t){ol.appendChild(el('li','',t))});
    box.appendChild(ol);box.appendChild(el('code','',n.path||''));
    var row2=el('div','row'),b1=el('button','go','Open the folder');b1.type='button';b1.onclick=function(){vapi('auto.openinstaller')};
    var b2=el('button','','Copy the file path');b2.type='button';b2.onclick=function(){navigator.clipboard.writeText(n.path||'').then(function(){toast('Path copied','ok')},function(){toast(n.path||'','warn')})};
    row2.appendChild(b1);row2.appendChild(b2);box.appendChild(row2);
  }else if(n.type==='fingerprint'){
    box.appendChild(el('h4','','Confirm the VPS identity'));
    box.appendChild(el('div','dim','The installer copies the VPS fingerprint to the clipboard and this page reads it by itself. It could not, so paste it here (Ctrl+V). It is only trusted if it matches what the VPS shows.'));
    if(n.error)box.appendChild(el('div','bad',n.error));
    var row3=el('div','row'),fi=el('input');fi.type='text';fi.placeholder='SHA256:...';fi.id='vaFp';
    var b3=el('button','go','Trust it');b3.type='button';b3.onclick=function(){vapi('auto.fingerprint',{fingerprint:fi.value}).then(function(x){if(x&&x.ok===false)toast(x.error,'bad');else{toast('Checking ...','ok');vaNeedSig=''}})};
    row3.appendChild(fi);row3.appendChild(b3);box.appendChild(row3);
  }else if(n.type==='rootpw'){
    box.appendChild(el('h4','','The database needs its MariaDB root password'));
    box.appendChild(el('div','dim','This is the root password of MariaDB on the VPS (set when MariaDB was installed there). It is used once to create the game database login, kept only in memory, and never written to a file or the log.'));
    if(n.error)box.appendChild(el('div','bad',n.error));
    var row4=el('div','row'),pi=el('input');pi.type='password';pi.autocomplete='off';pi.placeholder='MariaDB root password';pi.id='vaRoot';
    var b4=el('button','go','Continue');b4.type='button';
    b4.onclick=function(){var pw=pi.value;pi.value='';vapi('auto.rootpw',{password:pw}).then(function(x){if(x&&x.ok===false)toast(x.error,'bad');else vaNeedSig=''})};
    pi.onkeydown=function(e){if(e.key==='Enter')b4.click()};
    row4.appendChild(pi);row4.appendChild(b4);box.appendChild(row4);
  }
}
function vaStart(repair){$('#vaGo').disabled=true;$('#vaRepair').disabled=true;toast(repair?'Repairing the VPS ...':'Setting up the VPS ...','ok');vapi('auto.start',{withDb:$('#vaDb').checked,repair:!!repair}).then(function(x){if(x&&x.ok===false)toast(x.error,'bad');vaPoll()}).catch(function(e){toast('Could not start: '+(e&&e.message||e),'bad');vaPoll()})}
$('#vaGo').onclick=function(){vaStart(false)};
$('#vaRepair').onclick=function(){vaStart(true)};
$('#vaCancel').onclick=function(){vapi('auto.cancel').then(vaPoll)};
$('#vaStart').onclick=function(){vact('start','Start')};
$('#vaStop').onclick=function(){$('#vStop').click()};
$('#vaRestart').onclick=function(){$('#vRestart').click()};
$('#vaRefresh').onclick=function(){$('#vRefresh').click()};
/* ---------------- GitHub panel ---------------- */
var ghS=null;
function ghEsc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function ghLine(k,t){return '<div><span class="b '+k+'">'+({ok:'OK',warn:'NOTE',bad:'TO DO',dim:'–'}[k]||'')+'</span><span class="gx">'+ghEsc(t)+'</span></div>'}
function ghLoad(){vapi('git.status').then(function(r){if(r&&r.ok){ghS=r;ghRender()}})}
function ghRender(){
  var r=ghS;if(!r)return;
  var ri=$('#ghRepo');if(document.activeElement!==ri&&!ri.dataset.dirty)ri.value=r.repo||'';
  var a='';
  a+=r.gitFound?ghLine('ok','Git '+r.gitVersion):ghLine('bad','Git is not installed on this PC (git-scm.com).');
  a+=r.repo?ghLine('ok','Repository '+r.repo):ghLine('bad','Enter the repository above and press Save.');
  if(r.isRepo){a+=ghLine(r.changes>0?'warn':'ok',r.changes>0?r.changes+' file(s) changed since the last publish':'Nothing new since the last publish');if(r.last)a+=ghLine('dim','Last snapshot '+r.last)}
  else if(r.gitFound)a+=ghLine('warn','Not published yet: the first publish creates the repository in your server folder.');
  $('#ghPc').innerHTML=a;
  var v=r.vps||{},b='';
  if(v.ok===true)b+=ghLine('ok',v.note||'The VPS can read the repository.');
  else if(v.ok===false)b+=ghLine('bad',v.note||'Not checked yet.');
  else b+=ghLine('dim','Not checked yet. Press "Set up GitHub on the VPS" the first time.');
  $('#ghVps').innerHTML=b;
  var showKey=!!v.pubkey&&v.ok!==true;
  $('#ghKeyBox').hidden=!showKey;
  if(showKey){$('#ghKey').value=v.pubkey;$('#ghKeyLink').href=v.deployKeysUrl||'#'}
  $('#ghWhen').textContent=r.repo?'github.com/'+r.repo:'';
}
function ghDo(name,label,body){
  ['#ghPublish','#ghDown','#ghSetup','#ghCheck','#ghUpdate','#ghAll'].forEach(function(i){$(i).disabled=true});
  return vapi(name,body||{}).then(function(r){
    ['#ghPublish','#ghDown','#ghSetup','#ghCheck','#ghUpdate','#ghAll'].forEach(function(i){$(i).disabled=false});
    if(r&&r.needsConfirm==='dirty'){return dlg('Local files differ from GitHub',r.error,null,'Back up and download').then(function(v){if(v)return ghDo(name,label,Object.assign({},body||{},{confirm:true}));ghLoad()})}
    if(r&&r.needsConfirm==='existing'){return dlg('That repository already has content',r.error,null,'Use it anyway').then(function(v){if(v)return ghDo(name,label,Object.assign({},body||{},{useExisting:true}));ghLoad()})}
    vtoast(r,r&&r.note?r.note:label+' done');ghLoad();return r;
  });
}
$('#ghRepo').oninput=function(){this.dataset.dirty='1'};
$('#ghSave').onclick=function(){vapi('git.repo',{repo:$('#ghRepo').value}).then(function(r){if(r&&r.ok){$('#ghRepo').dataset.dirty='';$('#ghRepo').value=r.repo;toast('Repository saved','ok')}else toast((r&&r.error)||'Could not save','bad');ghLoad()})};
$('#ghPublish').onclick=function(){ghDo('git.publish','Publish',{repo:$('#ghRepo').value})};
$('#ghDown').onclick=function(){dlg('Download the server from GitHub to this PC?','Stop the local server first: files are replaced while it is off. Your own changed files are saved in a backup snapshot before anything is overwritten.',null,'Download').then(function(v){if(v)ghDo('git.download','Download',{repo:$('#ghRepo').value})})};
$('#ghSetup').onclick=function(){ghDo('git.vpssetup','VPS setup')};
$('#ghCheck').onclick=function(){ghDo('git.vpscheck','Access check')};
$('#ghUpdate').onclick=function(){dlg('Update the VPS from GitHub?','The server on the VPS is stopped while the new files are installed, then started again if it was running. Players are disconnected.',null,'Update VPS').then(function(v){if(v)ghDo('git.vpsupdate','Update')})};
$('#ghAll').onclick=function(){dlg('Publish and update the VPS?','Uploads this PC\'s server to GitHub, then installs it on the VPS. The VPS server is restarted if it was running.',null,'Publish and update').then(function(v){if(v)ghDo('git.all','Publish and update',{repo:$('#ghRepo').value})})};
$('#ghKeyCopy').onclick=function(){var t=$('#ghKey');t.select();try{document.execCommand('copy');toast('Key copied','ok')}catch(e){toast('Select the key and press Ctrl+C','warn')}};
setInterval(function(){if(curPage==='vps'&&!document.hidden)ghLoad()},60000);
function connect(){
  var es=new EventSource('/api/stream');
  es.addEventListener('backfill',function(e){lines=JSON.parse(e.data);redraw()});
  es.addEventListener('line',function(e){addLine(JSON.parse(e.data))});
  es.addEventListener('state',function(e){var prev=state&&state.resourcesCount;state=JSON.parse(e.data);render();pill();if(prev!==state.resourcesCount)loadRes()});
  es.addEventListener('progress',function(e){var m=JSON.parse(e.data);pEv(m.ev,m.p)});
  es.addEventListener('change',function(e){var c=JSON.parse(e.data);recent.push(c);if(recent.length>40)recent.shift();recentDraw();addChange(c);if(/^update\./.test(c.kind))loadUpd()});
  es.addEventListener('watch',function(e){watch=JSON.parse(e.data);renderWatch()});
  es.addEventListener('cmd',function(e){clOnCmd(JSON.parse(e.data))});
  es.onopen=function(){$('#offbar').hidden=true};
  es.addEventListener('alert',function(e){var a=JSON.parse(e.data);toast(a.text,a.level)});
  es.addEventListener('action',function(e){var a=JSON.parse(e.data);
    var isV=/VPS/.test(a.label||'')&&curPage==='vps';
    var pop=/VPS/.test(a.label||'')&&a.type==='person'&&Date.now()-lastClick<8000;
    if(a.state==='start'&&pop)vcmdOpen(a.id,a.label);
    if(a.state==='line'&&vcmdId&&vcmdId===a.id)vcmdLine(a.line);
    if(a.state==='end'&&vcmdId&&vcmdId===a.id)vcmdEnd(a.code);
    if(a.state==='start'){if(isV){vActId=a.id;vout('> '+a.label,'dash')}else{vActId=0;actBox.textContent='';actLine('> '+a.label,'dash');if(Date.now()-lastClick<8000&&a.type==='person'&&!pop){showPage('console');showTab('act')}else{var pa=document.querySelector('.tab[data-tab="act"]');if(pa&&tab!=='act')pa.classList.add('ping')}}}
    else if(a.state==='line'){if(vActId&&vActId===a.id)vout(a.line);else actLine(a.line)}
    else if(a.state==='end'){var m=a.code===0?'[ok] finished':'[exit '+a.code+'] finished';if(vActId&&vActId===a.id){vout(m,a.code===0?'dash':'error');vActId=0}else actLine(m,a.code===0?'dash':'error')}});
  es.onerror=function(){$('#pilltxt').textContent='RECONNECTING';$('#offbar').hidden=false};
}
document.addEventListener('keydown',function(e){ if((e.ctrlKey||e.metaKey)&&e.key==='f'&&tab==='log'){e.preventDefault();$('#find').focus()} });
setInterval(function(){ if(state&&state.server.state==='online') $('#uptime').textContent=fmtUp(state.server.startedAt) },1000);
api('/api/state').then(function(s){state=s;render();whoShow()});
var SU=null,suRestart=false;
function loadSelf(){api('/api/launcher').then(function(r){if(r&&r.ok!==false){SU=r;renderSelf()}})}
function renderSelf(){
  var r=SU;if(!r)return;var box=$('#selfstate');box.textContent='';
  var names={norepo:'NOT CONNECTED',missing:'REPOSITORY NOT FOUND',empty:'REPOSITORY IS EMPTY',error:'CANNOT REACH GITHUB',current:'UP TO DATE',update:'UPDATE AVAILABLE',local:'THIS PC IS AHEAD OF GITHUB'};
  var cls={norepo:'warn',missing:'bad',empty:'warn',error:'bad',current:'ok',update:'warn',local:'warn'};
  var h=el('div','selfhead '+(cls[r.state]||''));h.appendChild(el('b','',names[r.state]||r.state));
  if(r.repo){var a=el('span','dim',' github.com/'+r.repo+' ('+r.branch+')');h.appendChild(a)}box.appendChild(h);
  if(r.note)box.appendChild(el('div','dim selfnote',r.note));
  if(r.remote){var rm=el('div','selfrow2');rm.appendChild(el('span','dim','GitHub: '));rm.appendChild(el('b','',r.remote.short));rm.appendChild(el('span','dim','  '+(r.remote.date?new Date(r.remote.date).toLocaleString():'')+'  '+(r.remote.author||'')));box.appendChild(rm);if(r.remote.message)box.appendChild(el('div','dim selfnote','"'+r.remote.message+'"'))}
  if(r.files&&r.files.length){var t=el('div','selffiles');r.files.forEach(function(f){var x=el('div','selff '+(f.same?'ok':'diff'));x.appendChild(el('span','',f.file));x.appendChild(el('span','dim',f.missing?'not on GitHub':(f.same?'same ('+f.local+')':'this PC '+f.local+'  /  GitHub '+f.remote)));t.appendChild(x)});box.appendChild(t)}
  if(r.lastAt)box.appendChild(el('div','dim selfnote','Last sync: '+new Date(r.lastAt).toLocaleString()+(r.lastBy?' by '+r.lastBy:'')));
  $('#selfRepo').value=$('#selfRepo')===document.activeElement?$('#selfRepo').value:(r.repo||'');$('#selfBranch').value=$('#selfBranch')===document.activeElement?$('#selfBranch').value:(r.branch||'main');
  $('#bSelfInstall').hidden=r.state!=='update';
  $('#bSelfPublish').hidden=!r.repo||r.state==='missing'||r.state==='current'||r.state==='norepo'||r.state==='error';
  $('#bSelfCreate').hidden=r.state!=='missing';
  $('#bSelfRoll').hidden=!r.backups;$('#bSelfRoll').title=r.backups+' backup'+(r.backups===1?'':'s')+' kept';
  $('#bSelfRestart').classList.toggle('go',suRestart);
  $('#selfhelp').textContent=!r.tokenSet?'To publish (or to read a private repository) put  set "GITHUB_TOKEN=..."  in ChoomVille_Secrets.cmd. A token with "repo" access works; fine-grained needs Contents: read and write'+(r.state==='missing'?' and Administration to create the repository':'')+'.':'Install keeps a backup, checks both files for errors first, and never changes anything if a check fails. A restart loads the new version.';
  var zt=$('#selfzipt'),zs=r.zips||[];
  if(zs.length){var z0=zs[0];zt.textContent='Found '+z0.name+' ('+Math.max(1,Math.round(z0.size/1024))+' KB, '+new Date(z0.mtime).toLocaleString()+')'+(zs.length>1?'  - the newest of '+zs.length+' zips is used':'')}
  else zt.textContent='Download the repository as a zip on GitHub (Code > Download ZIP) and put it in the zip folder, then press Update from zip.';
  $('#bSelfZip').disabled=!zs.length;
  $('#selfwhen').textContent=r.state==='current'?'(up to date)':'';
}
function selfDone(r,keepRestart){if(r&&r.ok===false){toast(r.error||'That did not work','bad')}else{toast((r&&r.note)||'Done','ok');if(r&&r.restartNeeded){suRestart=true}}loadSelf()}
$('#bSelfSave').onclick=function(){api('/api/launcher/repo',{repo:$('#selfRepo').value,branch:$('#selfBranch').value}).then(function(r){selfDone(r)})};
$('#bSelfCheck').onclick=function(){var b=$('#bSelfCheck');b.disabled=true;api('/api/launcher').then(function(r){b.disabled=false;if(r&&r.ok!==false){SU=r;renderSelf();toast(r.state==='current'?'The launcher matches GitHub.':r.state==='update'?'A newer launcher is on GitHub.':(r.note||'Checked.'),r.state==='current'?'ok':'warn')}else toast((r&&r.error)||'Check failed','bad')})};
$('#bSelfInstall').onclick=function(){dlg('Update the launcher from GitHub?','Both files are downloaded and checked first, the current ones are backed up, then swapped in. You restart the launcher afterwards to use the new version. Servers keep running.',null,'Update launcher').then(function(v){if(v)api('/api/launcher/install',{}).then(function(r){selfDone(r)})})};
$('#bSelfPublish').onclick=function(){dlg('Publish this launcher to GitHub?','Pushes server.js and vps.js from this PC to the repository as one commit. Your settings, secrets and logs are never uploaded.',null,'Publish').then(function(v){if(v)api('/api/launcher/publish',{}).then(function(r){selfDone(r)})})};
$('#bSelfCreate').onclick=function(){dlg('Create the repository and publish?','Creates a PRIVATE repository on GitHub with this name and uploads server.js and vps.js. Needs a token that may create repositories.',null,'Create and publish').then(function(v){if(v)api('/api/launcher/publish',{create:true}).then(function(r){selfDone(r)})})};
$('#bSelfRoll').onclick=function(){dlg('Go back to the previous launcher?','Puts back the files saved before the last update. Restart the launcher afterwards.',null,'Roll back').then(function(v){if(v)api('/api/launcher/rollback',{}).then(function(r){selfDone(r)})})};
$('#bSelfRestart').onclick=function(){dlg('Restart the launcher?','The launcher closes and starts again (a new browser tab opens). The game server keeps running.',null,'Restart launcher').then(function(v){if(v)api('/api/launcher/restart',{}).then(function(r){if(r&&r.ok===false)toast(r.error,'bad');else{toast(r.note||'Restarting ...','ok');$('#offbar').hidden=false}})})};
$('#bSelfZipOpen').onclick=function(){api('/api/launcher/openzips',{}).then(function(r){if(r&&r.ok===false)toast(r.error,'bad');else loadSelf()})};
$('#bSelfZip').onclick=function(){var z=(SU&&SU.zips&&SU.zips[0])||null;if(!z){toast('No zip in the zip folder yet','warn');return}dlg('Update the launcher from '+z.name+'?','The files are read from the zip and checked first, the current ones are backed up, then swapped in. Restart the launcher afterwards to use the new version. Your settings (dashboard.json) are not touched.',null,'Update from zip').then(function(v){if(v)api('/api/launcher/zip',{file:z.name}).then(function(r){selfDone(r)})})};
loadSelf();setInterval(loadSelf,300000);
var modsData=null,nameBusy=false;
function fmtSz(n){if(!n)return '-';if(n>=1048576)return (n/1048576).toFixed(1)+' MB';return Math.max(1,Math.round(n/1024))+' KB'}
/* ---------------- colour codes in server names ($ff0 yellow, $o bold, $z reset ...) ---------------- */
function vfmt(src){
  var frag=document.createDocumentFragment(),s=String(src==null?'':src),buf='';
  var st={c:'',o:0,i:0,n:0,w:0,t:0,s:0};
  function flush(){if(!buf)return;var sp=document.createElement('span'),t=buf;buf='';if(st.t)t=t.toUpperCase();sp.textContent=t;
    if(st.c)sp.style.color=st.c;if(st.o)sp.style.fontWeight='700';if(st.i)sp.style.fontStyle='italic';
    if(st.n)sp.style.fontStretch='75%';if(st.w)sp.style.fontStretch='125%';if(st.s)sp.style.textShadow='1px 1px 2px rgba(0,0,0,.9)';frag.appendChild(sp)}
  for(var i=0;i<s.length;i++){
    var ch=s.charAt(i);
    if(ch!=='$'){buf+=ch;continue}
    var nx=s.charAt(i+1);
    if(nx==='$'){buf+='$';i++;continue}
    var h=s.substr(i+1,3);
    if(/^[0-9a-fA-F]{3}$/.test(h)){flush();st.c='#'+h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);i+=3;continue}
    var l=nx.toLowerCase();
    if(l==='o'||l==='i'||l==='t'||l==='s'){flush();st[l]=1;i++;continue}
    if(l==='n'){flush();st.n=1;st.w=0;i++;continue}
    if(l==='w'){flush();st.w=1;st.n=0;i++;continue}
    if(l==='g'){flush();st.c='';i++;continue}
    if(l==='z'){flush();st={c:'',o:0,i:0,n:0,w:0,t:0,s:0};i++;continue}
    buf+='$'}
  flush();return frag}
function vplain(src){return String(src==null?'':src).replace(/\$\$/g,'\u0001').replace(/\$([0-9a-fA-F]{3}|[oOiItTsSnNwWgGzZ])/g,'').replace(/\u0001/g,'$')}

/* ---------------- Server page: the public details in server.jsonc ---------------- */
var SI=null,siLast=null,siCtl={};
function siSet(node,txt){node.textContent='';node.appendChild(vfmt(txt))}
function siVal(k){var c=siCtl[k];if(!c)return null;return c.type==='checkbox'?c.checked:c.value}
function siOrig(k){var c=siCtl[k];return c?c.dataset.orig:''}
function siDirty(){var n=0;Object.keys(siCtl).forEach(function(k){var c=siCtl[k];var d=c.type==='checkbox'?(String(c.checked)!==c.dataset.orig):(c.value!==c.dataset.orig);c.classList.toggle('dirty',d);if(d)n++});
  $('#srvsave').disabled=!n;$('#srvdiscard').disabled=!n;$('#srvmsg').textContent=n?(n+' unsaved change'+(n>1?'s':'')):'No changes'}
function siPreview(){
  var nm=siCtl['identity.name'],ds=siCtl['identity.description'];
  siSet($('#spName'),nm?nm.value:'');siSet($('#spDesc'),ds?ds.value:'');
  var m=$('#spMeta');m.textContent='';
  function chip(t,c){var x=el('span','spchip'+(c?' '+c:''),t);m.appendChild(x)}
  var vis=siVal('identity.visibility');if(vis)chip(vis,vis==='public'?'ok':'');
  var mp=siVal('network.maximumPlayers');if(mp)chip(mp+' slots');
  var lo=siVal('identity.locale');if(lo)chip(lo);
  var tg=siVal('identity.tags');if(tg)String(tg).split(/[\s,;]+/).filter(Boolean).slice(0,16).forEach(function(t){chip('#'+t)});
  var ws=siVal('identity.website');if(ws)chip(String(ws).replace(/^https?:\/\//,''))}
function siField(f){
  var row=el('div','sfld'+(f.type==='area'?' wide':'')),id='si_'+f.k.replace(/\./g,'_');
  var lab=el('label','',f.label);lab.htmlFor=id;var c,orig;
  if(f.type==='bool'){c=el('input');c.type='checkbox';c.checked=!!f.value;orig=String(!!f.value);lab.className='chk';row.appendChild(c);row.appendChild(lab)}
  else{
    if(f.type==='area'){c=el('textarea');c.rows=4;c.value=f.value==null?'':String(f.value)}
    else if(f.type==='enum'){c=el('select');(f.opts||[]).forEach(function(o){var op=el('option','',o);op.value=o;c.appendChild(op)});c.value=f.value==null?(f.opts||[''])[0]:String(f.value)}
    else{c=el('input');c.type='text';c.autocomplete='off';c.spellcheck=false;c.value=f.type==='tags'?(Array.isArray(f.value)?f.value.join(', '):''):(f.value==null?'':String(f.value))}
    orig=c.value;row.appendChild(lab);row.appendChild(c)}
  c.id=id;c.dataset.orig=orig;c.dataset.k=f.k;siCtl[f.k]=c;
  c.oninput=c.onchange=function(){siDirty();siPreview()};
  if(f.k==='identity.name'||f.k==='identity.description')c.onfocus=function(){siLast=c};
  if(f.hint)row.appendChild(el('div','shint dim',f.hint));
  return row}
var CODE_COLS=[['ff0','Yellow'],['f80','Orange'],['f00','Red'],['f0f','Pink'],['a6f','Purple'],['08f','Blue'],['0ff','Cyan'],['0f0','Green'],['6fa','Mint'],['fff','White'],['888','Grey']];
var CODE_STY=[['o','Bold','B'],['i','Italic','I'],['n','Narrow','n'],['w','Wide','W'],['t','Upper','T'],['s','Shadow','S'],['g','Default colour','g'],['z','Reset all','z']];
function siInsert(code){
  var t=siLast||siCtl['identity.name'];if(!t)return;t.focus();
  var a=t.selectionStart==null?t.value.length:t.selectionStart,b=t.selectionEnd==null?a:t.selectionEnd;
  t.value=t.value.slice(0,a)+code+t.value.slice(b);var p=a+code.length;try{t.setSelectionRange(p,p)}catch(e){}
  siDirty();siPreview()}
function siCodebar(){
  var b=$('#codebar');b.textContent='';
  b.appendChild(el('div','dim','Colour codes: click a colour or style to put its code into the name or description (whichever you clicked last). $z resets everything.'));
  var r1=el('div','cbrow');CODE_COLS.forEach(function(c){var x=el('button','cbcol');x.type='button';x.style.background='#'+c[0].charAt(0)+c[0].charAt(0)+c[0].charAt(1)+c[0].charAt(1)+c[0].charAt(2)+c[0].charAt(2);x.title=c[1]+'  $'+c[0];x.setAttribute('aria-label',c[1]);x.onclick=function(){siInsert('$'+c[0])};r1.appendChild(x)});b.appendChild(r1);
  var r2=el('div','cbrow');CODE_STY.forEach(function(c){var x=el('button','cbsty',c[2]);x.type='button';x.title=c[1]+'  $'+c[0];x.setAttribute('aria-label',c[1]);x.onclick=function(){siInsert('$'+c[0])};r2.appendChild(x)});b.appendChild(r2)}
function renderServerInfo(){
  if(!SI)return;var box=$('#srvff');box.textContent='';siCtl={};
  var groups=[['Identity',['identity.name','identity.description','identity.locale','identity.tags','identity.website','identity.discord','identity.visibility']],['Network',['network.maximumPlayers','network.port','network.publicEndpoint']],['Features',['masterServer.enabled','voice.enabled']]];
  groups.forEach(function(g){
    var h=el('div','sgrp',g[0]);box.appendChild(h);
    SI.fields.forEach(function(f){if(g[1].indexOf(f.k)>=0)box.appendChild(siField(f))});
    if(g[0]==='Identity'){var cb=el('div','codebar');cb.id='codebar';box.appendChild(cb)}});
  siCodebar();siDirty();siPreview();siLive()}
function siLive(){
  var b=$('#srvlive');if(!b||!state)return;b.textContent='';
  function row(k,v,c){var d=el('div','lrow');d.appendChild(el('span','dim',k));d.appendChild(el('b',c||'',v));b.appendChild(d)}
  var s=state.server.state;row('Game server',s,s==='online'?'ok':(s==='offline'?'bad':'warn'));
  if(s==='online'&&state.server.startedAt)row('Running for',fmtUp(state.server.startedAt));
  row('Database',state.db&&state.db.up?'up':'down',state.db&&state.db.up?'ok':'bad');
  var ep=siVal('network.publicEndpoint');row('Players connect to',ep||'(not set)');
  if(SI)row('Config file',SI.file);
  var d2=el('div','dim lnote','Changes are written to server.jsonc after a backup of it. The server reads them at its next start.');b.appendChild(d2)}
function loadServerInfo(){
  api('/api/serverinfo/get',{}).then(function(r){
    if(r&&r.ok){SI=r;renderServerInfo()}
    else{$('#srvff').textContent='';$('#srvff').appendChild(el('div','sfail',(r&&r.error)||'Could not read the server config.'));$('#srvff').appendChild(el('div','dim','Check the server folder on the Settings page.'))}})}
$('#srvsave').onclick=function(){
  var ch={};Object.keys(siCtl).forEach(function(k){var c=siCtl[k],d=c.type==='checkbox'?(String(c.checked)!==c.dataset.orig):(c.value!==c.dataset.orig);if(d)ch[k]=siVal(k)});
  if(!Object.keys(ch).length)return;var b=$('#srvsave');b.disabled=true;
  api('/api/serverinfo/set',{changes:ch}).then(function(r){
    if(r&&r.ok===false){toast(r.error||'Could not save','bad');b.disabled=false;return}
    toast((r&&r.note)||'Saved','ok');loadServerInfo();api('/api/state').then(function(s){state=s;render()})})
   .catch(function(){toast('No answer from the panel','bad');b.disabled=false})};
$('#srvdiscard').onclick=function(){renderServerInfo()};

/* ---------------- Settings page ---------------- */
var SET=null,setCtl={};
function setDirty(){var n=0;Object.keys(setCtl).forEach(function(k){var c=setCtl[k],d=c.value!==c.dataset.orig;c.classList.toggle('dirty',d);if(d)n++});
  $('#setsave').disabled=!n;$('#setdiscard').disabled=!n;$('#setmsg').textContent=n?(n+' unsaved change'+(n>1?'s':'')):'No changes'}
function setField(f){
  var row=el('div','sfld'),id='sf_'+f.k.replace(/\./g,'_');var lab=el('label','',f.label);lab.htmlFor=id;
  var c=el('input');c.type='text';c.id=id;c.autocomplete='off';c.spellcheck=false;c.value=f.value==null?'':String(f.value);c.dataset.orig=c.value;c.dataset.k=f.k;
  if(f.type==='port'||f.type==='int')c.inputMode='numeric';
  c.oninput=setDirty;setCtl[f.k]=c;row.appendChild(lab);row.appendChild(c);
  var hint=(f.hint||'')+(f.restart?' (needs a restart of the panel)':'');if(hint)row.appendChild(el('div','shint dim',hint));
  if(f.k==='serverDir'&&SET){var ok=SET.serverDirOk;var m=el('div','shint '+(ok?'ok':'bad'),ok?('Found: '+SET.serverDirResolved):('Not found: '+SET.serverDirResolved));row.appendChild(m)}
  return row}
function renderSettings(){
  if(!SET)return;setCtl={};
  var ab=$('#setabout');ab.textContent='';
  var lg=document.querySelector('.brand .logo');
  var top=el('div','abtop');if(lg){var im=el('img','ablogo');im.src=lg.src;im.alt='VNR Network';top.appendChild(im)}
  var tt=el('div','abtt');tt.appendChild(el('div','abname',SET.product.name));tt.appendChild(el('div','dim',SET.product.brand+'  -  build '+SET.product.build));top.appendChild(tt);ab.appendChild(top);
  ab.appendChild(el('div','abtxt','Run, back up, update and watch your Cyberpunk 2077 (Open77) server from one page. Built by '+SET.product.brand+'.'));
  var ar=el('div','abrow');
  var a1=el('a','abbtn go',SET.product.siteShort+' ↗');a1.href=SET.product.site;a1.target='_blank';a1.rel='noopener';ar.appendChild(a1);
  var a2=el('a','abbtn','Contact');a2.href='mailto:'+SET.product.contact;ar.appendChild(a2);
  var b3=el('button','abbtn','Check for panel updates');b3.type='button';b3.onclick=function(){showPage('updates')};ar.appendChild(b3);ab.appendChild(ar);
  var bx=function(id,list){var x=$(id);x.textContent='';list.forEach(function(f){x.appendChild(setField(f))})};
  bx('#setsrvf',SET.groups.server);bx('#setbkf',SET.groups.backups);bx('#setlnf',SET.groups.launcher);
  var ex=$('#setlnx');ex.textContent='';
  var r1=el('div','sfld');r1.appendChild(el('label','','Speed mode'));var sel=el('select');[['auto','Auto (light mode on a slow PC)'],['normal','Normal'],['light','Light (slower refresh, less CPU)']].forEach(function(o){var op=el('option','',o[1]);op.value=o[0];sel.appendChild(op)});sel.value=SET.perf.pref;
  sel.onchange=function(){api('/api/perf',{mode:sel.value}).then(function(r){toast(r&&r.ok===false?r.error:(r.note||'Saved'),r&&r.ok===false?'bad':'ok');var p=$('#perfsel');if(p)p.value=sel.value})};
  r1.appendChild(sel);r1.appendChild(el('div','shint dim','Light mode refreshes less often so the panel stays quick on a slow PC or VPS.'));ex.appendChild(r1);
  var r2=el('div','sfld');r2.appendChild(el('label','','Your name'));var wb=el('button','',(WHO||'operator')+'  (change)');wb.type='button';wb.onclick=function(){$('#bWho').click()};r2.appendChild(wb);r2.appendChild(el('div','shint dim','Shown in the command log next to what you did.'));ex.appendChild(r2);
  var cf=$('#setcfg');cf.textContent='Settings file: '+SET.configPath;
  var ch=$('#hc_settings');ch.textContent='';ch.appendChild(cp(SET.serverDirOk?'ok':'bad','Server folder',SET.serverDirOk?'found':'not found'));ch.appendChild(cp(SET.exeOk?'ok':'warn','Server program',SET.exeOk?'found':'not found'));
  setDirty()}
var LITE_UI=true;
function loadSettings(){api('/api/settings/get',{}).then(function(r){if(r&&r.ok){SET=r;renderSettings()}else toast((r&&r.error)||'Could not load the settings','bad')})}
$('#setsave').onclick=function(){
  var ch={};Object.keys(setCtl).forEach(function(k){var c=setCtl[k];if(c.value!==c.dataset.orig)ch[k]=c.value});
  if(!Object.keys(ch).length)return;var b=$('#setsave');b.disabled=true;
  api('/api/settings/set',{changes:ch}).then(function(r){
    if(r&&r.ok===false){toast(r.error||'Could not save','bad');b.disabled=false;return}
    toast((r&&r.note)||'Saved','ok');loadSettings();api('/api/state').then(function(s){state=s;render()})})
   .catch(function(){toast('No answer from the panel','bad');b.disabled=false})};
$('#setdiscard').onclick=function(){renderSettings()};

function drawBrand(){
  if(!state||state.mode==='vps')return;
  var n=state.serverName||'';var s=$('#sub');if(!s)return;
  if(s.dataset.nm!==n){s.dataset.nm=n;s.textContent='';if(n)s.appendChild(vfmt(n));else s.textContent='...'}
  s.title=vplain(state.serverFull||n)+' - click to see and change the server details';
}
function renameDlg(){
  var cur=(modsData&&modsData.name)||(state&&state.serverFull)||(state&&state.serverName)||'';
  var d=$('#ndlg'),inp=$('#ninp');inp.value=cur;$('#nerr').textContent='';
  function done(){d.close();$('#nyes').onclick=$('#nno').onclick=null}
  $('#nno').onclick=done;
  $('#nyes').onclick=function(){
    var v=inp.value.trim();if(!v){$('#nerr').textContent='Type a name first.';return}
    $('#nyes').disabled=true;
    api('/api/server/name',{name:v}).then(function(r){
      $('#nyes').disabled=false;
      if(r&&r.ok===false){$('#nerr').textContent=r.error||'failed';return}
      done();toast((r&&r.note)||'Server name saved','ok');if(modsData)modsData.name=v;loadMods();
    });
  };
  inp.onkeydown=function(e){if(e.key==='Enter')$('#nyes').click()};
  d.showModal();inp.focus();inp.select();
}
function loadMods(){api('/api/mods').then(function(r){modsData=r;drawMods()})}
function modsDone(r,ok){if(r&&r.ok===false)toast(r.error||'failed','bad');else toast((r&&r.note)||ok||'Saved','ok');loadMods()}
function mbadge(t,c){return el('span','badge '+(c||''),t)}
function drawMods(){
  var r=modsData;if(!r)return;
  var box=$('#modsbox');box.textContent='';
  if(r.error){box.appendChild(el('div','bad pad',r.error));return}
  setChips('mods',[[r.enabled?'ok':'warn','Required mods',r.enabled?'ON':'OFF'],['info','Mods',String(r.packages.length)],[r.unsecured?'warn':'ok','Unsecured',r.unsecured?'ON':'off']]);
  // name
  var sn=el('section','');sn.appendChild(el('h2','','Server name'));var p=el('div','pad modrow');
  var nm=el('div','modname',r.name||'(no name set)');nm.title=r.name||'';p.appendChild(nm);
  var bn=el('button','','Rename');bn.type='button';bn.onclick=renameDlg;p.appendChild(bn);
  p.appendChild(el('div','dim modhelp','Shown in the launcher header and in the server list. Saved into server.jsonc (a backup is kept first); restart the server for the list to update.'));
  sn.appendChild(p);box.appendChild(sn);
  // settings
  var ss=el('section','');ss.appendChild(el('h2','','Rules'));var q=el('div','pad');
  function tog(label,help,on,key,warn){
    var row=el('div','modtog');var t=el('div','mt');t.appendChild(el('b','',label));t.appendChild(el('div','dim',help));row.appendChild(t);
    var b=el('button',on?'go':'','');b.type='button';b.textContent=on?'ON':'OFF';b.setAttribute('aria-pressed',on?'true':'false');
    b.onclick=function(){
      var go=function(){var o={};o[key]=!on;api('/api/mods/set',o).then(function(x){modsDone(x)})};
      if(warn&&!on)dlg('Turn on unsecured mods?','Players will be asked to accept mods that are not hash-verified. Only do this for mods you trust.',null,'Turn on').then(function(v){if(v)go()});else go();
    };
    row.appendChild(b);q.appendChild(row);
  }
  tog('Require mods','Players must have the list below installed to join. Off = the server asks for nothing.',r.enabled,'enabled',false);
  tog('Unsecured','Lets the server require mods that are not on the verified list (needed for hosted, executable mods).',r.unsecured,'unsecured',true);
  if(r.boot)q.appendChild(el('div','dim modhelp','Last server start: '+r.boot.declared+' mods declared, required '+(r.boot.enabled?'on':'off')+', unsecured '+(r.boot.unsecured?'on':'off')+(r.boot.digest?', set '+r.boot.digest.slice(0,10):'')+'. A different number than below means the server needs a restart.'));
  ss.appendChild(q);box.appendChild(ss);
  // required
  var rs=el('section','modwide');rs.appendChild(el('h2','','Required mods (' + r.packages.length + ')'));var lp=el('div','pad modlist');
  if(!r.packages.length)lp.appendChild(el('div','dim','No mods are required.'));
  r.packages.forEach(function(m){
    var row=el('div','modit');var l=el('div','ml');var h=el('div','mh');h.appendChild(el('b','',m.displayName||m.id));
    h.appendChild(mbadge(m.source));if(m.capability)h.appendChild(mbadge(m.capability,m.capability==='executable'?'warn':''));
    if(m.onDisk===true)h.appendChild(mbadge('on server','ok'));else if(m.onDisk===false)h.appendChild(mbadge('file missing','bad'));
    l.appendChild(h);l.appendChild(el('div','dim',m.id+(m.version?'  |  '+(m.source==='indexed'?'min ':'v')+m.version:'')+(m.sizeBytes?'  |  '+fmtSz(m.sizeBytes):'')));row.appendChild(l);
    var b=el('button','danger','Remove');b.type='button';b.onclick=function(){dlg('Remove '+(m.displayName||m.id)+'?','It will no longer be required of players. The server needs a restart.',null,'Remove').then(function(v){if(v)api('/api/mods/remove',{id:m.id}).then(function(x){modsDone(x)})})};
    row.appendChild(b);lp.appendChild(row);
  });
  rs.appendChild(lp);box.appendChild(rs);
  // add
  var as=el('section','modwide');as.appendChild(el('h2','','Add a mod'));var ap=el('div','pad');
  ap.appendChild(el('div','modsub','From the public mod index (small, verified downloads)'));
  var f=el('div','modadd');var i1=el('input','');i1.type='text';i1.placeholder='mod id  (for example archivexl)';i1.setAttribute('aria-label','Mod id');
  var i2=el('input','');i2.type='text';i2.placeholder='min version  (1.27.5)';i2.size=14;i2.setAttribute('aria-label','Minimum version');
  var ba=el('button','go','Add');ba.type='button';ba.onclick=function(){if(!i1.value.trim()){toast('Type the mod id first','bad');return}api('/api/mods/add',{id:i1.value.trim(),minVersion:i2.value.trim()}).then(function(x){modsDone(x)})};
  f.appendChild(i1);f.appendChild(i2);f.appendChild(ba);ap.appendChild(f);
  ap.appendChild(el('div','modsub','Already imported on this server, not required'));
  if(!r.spare.length)ap.appendChild(el('div','dim','Nothing else is in the server mods folder.'));
  r.spare.forEach(function(m){
    var row=el('div','modit');var l=el('div','ml');var h=el('div','mh');h.appendChild(el('b','',m.displayName));if(m.capability)h.appendChild(mbadge(m.capability,m.capability==='executable'?'warn':''));l.appendChild(h);
    l.appendChild(el('div','dim',m.id+'  |  v'+m.version+'  |  '+fmtSz(m.sizeBytes)));row.appendChild(l);
    var b=el('button','go','Require');b.type='button';b.onclick=function(){
      var go=function(){api('/api/mods/add',{id:m.id,sha256:m.sha256}).then(function(x){modsDone(x)})};
      if(m.capability==='executable'&&!r.unsecured)toast('This is an executable mod: turn Unsecured on first or players will be refused.','warn');
      go();
    };
    row.appendChild(b);ap.appendChild(row);
  });
  ap.appendChild(el('div','dim modhelp','Every change edits server.jsonc (backup first) and needs a server restart. Executable mods run code on the player PC, so only add ones you trust.'));
  as.appendChild(ap);box.appendChild(as);
}
$('#sub').onclick=function(){if(state&&state.mode!=='vps')showPage('server')};
$('#sub').style.cursor='pointer';
function askBackup(txt){return new Promise(function(res){var d=$('#bkdlg');$('#bktxt').textContent=txt;function done(v){d.close();$('#bkno').onclick=$('#bkskip').onclick=$('#bkyes').onclick=null;res(v)}$('#bkno').onclick=function(){done(null)};$('#bkskip').onclick=function(){done('skip')};$('#bkyes').onclick=function(){done('backup')};d.showModal();$('#bkno').focus()})}
function perfDraw(){var p=state&&state.perf;if(!p)return;var s=$('#perfsel');if(document.activeElement!==s&&s.value!==p.pref)s.value=p.pref;$('#perfnote').textContent=p.light?'Light mode is on ('+p.cpus+' cores, lag '+p.lagMs+' ms)':'Normal mode ('+p.cpus+' cores, lag '+p.lagMs+' ms)'}
$('#perfsel').onchange=function(){api('/api/perf',{mode:this.value}).then(function(r){toast(r&&r.ok===false?r.error:(r.note||'Saved'),r&&r.ok===false?'bad':'ok')})};
var crData=null,crWhich='current';
function crT(t){var d=new Date(t);return d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
function crSz(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
function loadCrash(){api('/api/crashes?file='+encodeURIComponent(crWhich)).then(function(r){crData=r;drawCrash()})}
function crText(){
  var r=crData;if(!r||r.error)return '';var o=['VNR launcher crash report','Log: '+r.label+' ('+r.file+')',''];
  r.runs.forEach(function(u,i){
    o.push('RUN '+(i+1)+': started '+u.start+' '+u.tz+', ended '+u.end+', '+u.status.toUpperCase()+', errors '+u.errors+', warnings '+u.warnings+(u.fatal?', FATAL '+u.fatal:''));
    u.hints.forEach(function(h){o.push('  likely: '+h)});
    u.sigs.slice(0,10).forEach(function(s){o.push('  '+s.count+'x ['+s.lvl+'] '+s.sample.slice(0,240));s.more.slice(0,4).forEach(function(m){o.push('       '+m)})});
    if(i===0){o.push('  last lines:');u.tail.forEach(function(l){o.push('    '+l)})}
    o.push('');
  });
  return o.join('\n');
}
function crCopy(){
  var t=crText();if(!t){toast('Nothing to copy','bad');return}
  function fb(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');toast('Report copied','ok')}catch(e){toast('Could not copy','bad')}a.remove()}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){toast('Report copied','ok')},fb);else fb();
}
function drawCrash(){
  var r=crData;if(!r)return;var box=$('#crbox');box.textContent='';
  var sel=$('#crsel');sel.textContent='';
  var o=document.createElement('option');o.value='current';o.textContent='Current server log';sel.appendChild(o);
  ((r.hist)||[]).forEach(function(h){var x=document.createElement('option');x.value=h.name;x.textContent='Saved '+crT(h.t)+' ('+crSz(h.size)+')';sel.appendChild(x)});
  sel.value=crWhich;
  if(r.error){setChips('crashes',[['warn','Log','not found']]);box.appendChild(el('div','bad pad',r.error));return}
  var u0=r.runs[0]||{};var bad=r.runs.filter(function(u){return u.status==='crashed'}).length;
  setChips('crashes',[[u0.status==='crashed'?'bad':u0.status==='clean'||u0.status==='running'?'ok':'warn','Latest run',String(u0.status||'-').toUpperCase()],[(u0.errors||0)?'bad':'ok','Errors',String(u0.errors||0)],[(u0.warnings||0)?'warn':'ok','Warnings',String(u0.warnings||0)],[bad?'bad':'ok','Crashed runs',String(bad)]]);
  var info=el('div','dim crinfo',r.label+'  |  '+crSz(r.size)+'  |  '+r.totalRuns+' run'+(r.totalRuns===1?'':'s')+' in this file');box.appendChild(info);
  if(r.events&&r.events.length){
    var s=el('section','');s.appendChild(el('h2','','Crashes the launcher noticed'));var p=el('div','pad');
    r.events.forEach(function(e){var row=el('div','crev');row.appendChild(el('b','',crT(e.t)));row.appendChild(el('span','dim',e.detail));p.appendChild(row)});
    s.appendChild(p);box.appendChild(s);
  }
  r.runs.forEach(function(u,i){
    var s=el('section','');var h=el('h2','',(i===0?'Latest run':'Run '+(r.totalRuns-i))+'  -  '+u.start);
    h.appendChild(document.createTextNode(' '));var st=el('span','badge '+(u.status==='crashed'?'bad':u.status==='clean'||u.status==='running'?'ok':'warn'),u.status);h.appendChild(st);s.appendChild(h);
    var p=el('div','pad');
    p.appendChild(el('div','dim','Ran until '+(u.end||'?')+'  |  '+u.lines+' lines  |  '+u.errors+' errors, '+u.warnings+' warnings'+(u.fatal?', '+u.fatal+' fatal':'')));
    if(u.status==='ended')p.appendChild(el('div','crwarn','This run just stops - there is no clean shutdown line. That is a crash, a closed window or a kill.'));
    u.hints.forEach(function(t){p.appendChild(el('div','crhint','Likely: '+t))});
    if(u.resources.length)p.appendChild(el('div','dim crres','Errors by resource: '+u.resources.map(function(x){return x[0]+' ('+x[1]+')'}).join(', ')));
    if(u.sigs.length){
      var tb=el('div','crsigs');u.sigs.forEach(function(g){
        var row=el('div','crsig '+g.lvl);row.appendChild(el('span','crn',g.count+'x'));row.appendChild(el('span','crl',g.lvl.toUpperCase()));
        var m=el('div','crm');m.appendChild(el('div','crs',g.sample));if(g.more.length)m.appendChild(el('pre','crmore',g.more.join('\n')));m.appendChild(el('div','dim',g.first.slice(11)+(g.count>1?'  to  '+g.last.slice(11):'')));row.appendChild(m);tb.appendChild(row)});
      p.appendChild(tb);
    }else p.appendChild(el('div','dim','No errors or warnings in this run.'));
    var d=document.createElement('details');d.appendChild(el('summary','','Last lines before it ended'));d.appendChild(el('pre','crtail',u.tail.join('\n')));if(i===0&&u.status!=='clean'&&u.status!=='running')d.open=true;p.appendChild(d);
    s.appendChild(p);box.appendChild(s);
  });
  if(r.dumps&&r.dumps.length){
    var s2=el('section','');s2.appendChild(el('h2','','Crash dump files found'));var p2=el('div','pad');
    r.dumps.forEach(function(d){var row=el('div','crev');row.appendChild(el('b','',d.name));row.appendChild(el('span','dim',crSz(d.size)+'  |  '+crT(d.t)+'  |  '+d.dir));p2.appendChild(row)});
    s2.appendChild(p2);box.appendChild(s2);
  }
}
$('#crsel').onchange=function(){crWhich=this.value;loadCrash()};
$('#bCrRefresh').onclick=loadCrash;
$('#bCrCopy').onclick=crCopy;
$('#bCrSave').onclick=function(){api('/api/crashes/save',{}).then(function(r){toast(r&&r.ok===false?r.error:(r.note||'Saved'),r&&r.ok===false?'bad':'ok');loadCrash()})};
$('#bCrOpen').onclick=function(){api('/api/crashes/open',{}).then(function(r){toast(r&&r.ok?'Opened the saved-logs folder':'Could not open it',r&&r.ok?'ok':'bad')})};


loadRes();loadUpd();loadWatch();loadVps();connect();setInterval(function(){if(curPage==='vps')loadVps()},10000);setInterval(loadUpd,20000);setInterval(loadWatch,60000);
})();
</script></body></html>`;
