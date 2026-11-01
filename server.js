'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'nebu.db'));
db.exec('PRAGMA journal_mode = WAL;');
// Each migration runs once, in order. The applied count is stored in PRAGMA user_version.
// To change the schema later, append a new entry; never edit an old one.
const MIGRATIONS = [
`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  visitor TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'desktop'
);
CREATE INDEX IF NOT EXISTS idx_views_user ON views(user_id, ts);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  link_id INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clicks_user ON clicks(user_id, ts);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
`
];
function migrate() {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return v;
}
const SCHEMA_VERSION = migrate();
const backup = require('./backup.js')(db); // encrypted GitHub snapshots, see backup.js

// ---------- helpers ----------
const RESERVED = new Set(['api', 'go', 'login', 'signup', 'dashboard', 'static', 'assets', 'admin', 'app',
  'index', 'profile', 'logout', 'terms', 'privacy', 'about', 'features', 'pricing', 'help', 'support',
  'nebu', 'www', 'public', 'favicon.ico', 'robots.txt']);
const FONTS = ['Inter', 'Space Grotesk', 'JetBrains Mono', 'Playfair Display', 'Press Start 2P', 'Caveat', 'Outfit'];
const BGS = ['aurora', 'particles', 'grid', 'gradient', 'stars', 'waves', 'solid'];
const CARDS = ['glass', 'solid', 'outline', 'neon'];
const DEFAULT_PROFILE = {
  displayName: '', bio: '', avatar: '', location: '', discord: '',
  bg: 'aurora', color1: '#7c5cff', color2: '#19d3c5', accent: '#a78bfa', text: '#f4f3ff',
  font: 'Inter', card: 'glass', music: '', views: true, glow: true, typewriter: false
};

const now = () => Date.now();
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function safeUrl(u, allowMailto = true) {
  if (typeof u !== 'string') return null;
  u = u.trim();
  if (!u || u.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    if (p.protocol === 'http:' || p.protocol === 'https:') return p.href;
    if (allowMailto && p.protocol === 'mailto:') return p.href;
  } catch { /* ignore */ }
  return null;
}
function cleanProfile(input, base) {
  const p = { ...DEFAULT_PROFILE, ...base };
  if (!input || typeof input !== 'object') return p;
  if ('displayName' in input) p.displayName = str(input.displayName, 40);
  if ('bio' in input) p.bio = str(input.bio, 200);
  if ('location' in input) p.location = str(input.location, 40);
  if ('discord' in input) p.discord = str(input.discord, 40);
  if ('avatar' in input) p.avatar = input.avatar ? (safeUrl(input.avatar, false) || '') : '';
  if ('music' in input) p.music = input.music ? (safeUrl(input.music, false) || '') : '';
  if ('bg' in input && BGS.includes(input.bg)) p.bg = input.bg;
  if ('font' in input && FONTS.includes(input.font)) p.font = input.font;
  if ('card' in input && CARDS.includes(input.card)) p.card = input.card;
  for (const k of ['color1', 'color2', 'accent', 'text']) if (k in input) p[k] = hex(input[k], p[k]);
  for (const k of ['views', 'glow', 'typewriter']) if (k in input) p[k] = !!input[k];
  return p;
}
const parseProfile = (row) => { try { return { ...DEFAULT_PROFILE, ...JSON.parse(row.profile) }; } catch { return { ...DEFAULT_PROFILE }; } };
function badgesFor(user) {
  const b = [];
  if (user.id <= 250) b.push({ id: 'og', label: 'OG', hint: 'First 250 members' });
  if (user.username.length <= 3) b.push({ id: 'short', label: 'Short name', hint: '3 characters or fewer' });
  if (now() - user.created_at > 30 * 86400e3) b.push({ id: 'vet', label: 'Veteran', hint: '30+ days' });
  return b;
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function deviceOf(ua = '') { return /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop'; }
function refOf(ref = '', host = '') {
  if (!ref) return 'Direct';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    return h === host ? 'Direct' : h;
  } catch { return 'Direct'; }
}
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const b = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (b.length >= max) { buckets.set(key, b); return false; }
  b.push(t); buckets.set(key, b); return true;
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (!v.some((x) => t - x < 3600e3)) buckets.delete(k); db.prepare('DELETE FROM sessions WHERE expires < ?').run(t); }, 600e3).unref();


// ---------- tiny zero-dependency web layer (replaces express) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function createApp() {
  const routes = []; const mws = []; let notFoundH = null; let errH = null;
  const add = (method) => (p, ...h) => { const keys = []; const re = new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'); routes.push({ method, re, keys, h }); };
  const api = {
    use(a, b) { if (typeof a === 'string') mws.push({ prefix: a, fn: b }); else if (b === undefined && a.length >= 3 && a.length === 3) mws.push({ prefix: '', fn: a }); else if (a.length === 4) errH = a; else notFoundH = a; },
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    disable() {}, set() {}
  };
  api.handler = async (req, res) => {
    const u = new URL(req.url, 'http://x');
    req.path = decodeURIComponent(u.pathname); req.query = Object.fromEntries(u.searchParams); req.ip = req.socket.remoteAddress;
    if (process.env.TRUST_PROXY && req.headers['x-forwarded-for']) req.ip = req.headers['x-forwarded-for'].split(',')[0].trim();
    req.is = (t) => (req.headers['content-type'] || '').includes(t);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = (t) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(t); };
    res.redirect = (c, url) => { if (typeof c === 'string') { url = c; c = 302; } res.statusCode = c; res.setHeader('Location', url); res.end(); };
    res.sendFile = (f) => { fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('Not found'); } res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(d); }); };
    try {
      // body
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 50e3) { res.statusCode = 413; return res.end('Too large'); } chunks.push(c); }
        const raw = Buffer.concat(chunks).toString();
        req.body = {};
        if (raw && req.is('application/json')) { try { req.body = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); } }
        else if (raw) req.rawBody = raw;
      } else req.body = {};
      const chain = [];
      for (const m of mws) if (req.path.startsWith(m.prefix)) chain.push(m.fn);
      let matched = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(req.path);
        if (m) { req.params = {}; r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); }); matched = r; break; }
      }
      // routes registered after static middleware must still run after it: static is a middleware in chain
      const seq = [...chain, ...(matched ? matched.h : [])];
      let i = 0;
      const next = (err) => {
        if (err) return errH ? errH(err, req, res, () => {}) : (res.statusCode = 500, res.end('Server error'));
        const fn = seq[i++];
        if (!fn) { if (res.writableEnded) return; return notFoundH ? notFoundH(req, res) : (res.statusCode = 404, res.end('Not found')); }
        try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); }
      };
      next();
    } catch (e) { console.error(e); if (!res.writableEnded) { res.statusCode = 500; res.end('Server error'); } }
  };
  api.listen = (port, cb) => http.createServer(api.handler).listen(port, cb);
  return api;
}
const express = Object.assign(() => createApp(), {
  json: () => (req, res, next) => next(),
  static: (dir) => (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (/^\/dashboard(\.html)?$/.test(req.path)) return next();
    let p = req.path === '/' ? '/index.html' : req.path;
    const tryFiles = [p, p + '.html'];
    for (const t of tryFiles) {
      const f = path.join(dir, t);
      if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.sendFile(f);
    }
    next();
  }
});

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '50kb' }));
// Anything that can change stored data (writes, link clicks) schedules a backup snapshot.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/go/')) res.on('finish', () => { if (res.statusCode < 500) backup.markDirty(); });
  next();
});

app.use((req, res, next) => {
  const tok = parseCookies(req).nebu_session;
  req.user = null;
  if (tok) {
    const s = db.prepare('SELECT user_id, expires FROM sessions WHERE token = ?').get(tok);
    if (s && s.expires > now()) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  }
  next();
});
// CSRF guard: state-changing API calls must be JSON
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['content-length'] !== '0'
    && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});
const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not signed in' }));

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(token, userId, now() + 30 * 86400e3);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nebu_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
}
const publicUser = (u) => ({
  id: u.id, uid: u.id, username: u.username, email: u.email, createdAt: u.created_at,
  profile: parseProfile(u), badges: badgesFor(u)
});

// ---------- auth ----------
const USERNAME_RE = /^[a-z0-9_.-]{1,30}$/;
app.get('/api/check/:username', (req, res) => {
  const u = req.params.username.toLowerCase();
  if (!USERNAME_RE.test(u)) return res.json({ available: false, reason: 'Use 1-30 letters, numbers, _ . -' });
  if (RESERVED.has(u)) return res.json({ available: false, reason: 'Reserved' });
  const row = db.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
  res.json({ available: !row, reason: row ? 'Taken' : '' });
});
app.post('/api/signup', (req, res) => {
  if (!rateLimit('signup:' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Too many attempts, try later' });
  const username = str(req.body.username, 30).toLowerCase();
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 1-30 chars, letters, numbers, _ . -' });
  if (RESERVED.has(username)) return res.status(400).json({ error: 'That name is reserved' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username is taken' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  const salt = crypto.randomBytes(16).toString('hex');
  const profile = { ...DEFAULT_PROFILE, displayName: username };
  const r = db.prepare('INSERT INTO users (username, email, salt, hash, profile, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, email, salt, hashPw(password, salt), JSON.stringify(profile), now());
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO links (user_id, title, url, position) VALUES (?, ?, ?, 0)').run(id, 'My website', 'https://example.com');
  startSession(res, id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});
app.post('/api/login', (req, res) => {
  if (!rateLimit('login:' + req.ip, 20, 900e3)) return res.status(429).json({ error: 'Too many attempts, try later' });
  const id = str(req.body.login, 120).toLowerCase();
  const pw = typeof req.body.password === 'string' ? req.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id);
  const fake = '0'.repeat(32);
  const h = hashPw(pw, u ? u.salt : fake);
  const ok = u && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Wrong username/email or password' });
  startSession(res, u.id);
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', (req, res) => {
  const tok = parseCookies(req).nebu_session;
  if (tok) db.prepare('DELETE FROM sessions WHERE token = ?').run(tok);
  res.setHeader('Set-Cookie', 'nebu_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

// ---------- profile ----------
app.put('/api/profile', need, (req, res) => {
  const p = cleanProfile(req.body, parseProfile(req.user));
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(p), req.user.id);
  res.json({ profile: p });
});
app.put('/api/username', need, (req, res) => {
  const u = str(req.body.username, 30).toLowerCase();
  if (!USERNAME_RE.test(u) || RESERVED.has(u)) return res.status(400).json({ error: 'Invalid or reserved name' });
  if (u === req.user.username) return res.json({ username: u });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) return res.status(409).json({ error: 'Username is taken' });
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(u, req.user.id);
  res.json({ username: u });
});
app.delete('/api/account', need, (req, res) => {
  const id = req.user.id;
  for (const t of ['links', 'views', 'clicks', 'sessions']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.setHeader('Set-Cookie', 'nebu_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- links ----------
const linkRow = (l) => ({ id: l.id, title: l.title, url: l.url, hidden: !!l.hidden, pinned: !!l.pinned, clicks: l.clicks, position: l.position });
app.get('/api/links', need, (req, res) => {
  res.json({ links: db.prepare('SELECT * FROM links WHERE user_id = ? ORDER BY pinned DESC, position ASC, id ASC').all(req.user.id).map(linkRow) });
});
app.post('/api/links', need, (req, res) => {
  const title = str(req.body.title, 80);
  const url = safeUrl(req.body.url);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!url) return res.status(400).json({ error: 'Enter a valid http(s) or mailto link' });
  const count = db.prepare('SELECT COUNT(*) c, COALESCE(MAX(position),0) m FROM links WHERE user_id = ?').get(req.user.id);
  if (count.c >= 100) return res.status(400).json({ error: 'Link limit reached (100)' });
  const r = db.prepare('INSERT INTO links (user_id, title, url, position) VALUES (?, ?, ?, ?)').run(req.user.id, title, url, count.m + 1);
  res.json({ link: linkRow(db.prepare('SELECT * FROM links WHERE id = ?').get(Number(r.lastInsertRowid))) });
});
app.put('/api/links/reorder', need, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  const upd = db.prepare('UPDATE links SET position = ? WHERE id = ? AND user_id = ?');
  ids.forEach((id, i) => upd.run(i, id, req.user.id));
  res.json({ ok: true });
});
app.put('/api/links/:id', need, (req, res) => {
  const l = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  let { title, url } = l;
  if ('title' in req.body) { title = str(req.body.title, 80); if (!title) return res.status(400).json({ error: 'Title is required' }); }
  if ('url' in req.body) { url = safeUrl(req.body.url); if (!url) return res.status(400).json({ error: 'Invalid link' }); }
  const hidden = 'hidden' in req.body ? (req.body.hidden ? 1 : 0) : l.hidden;
  const pinned = 'pinned' in req.body ? (req.body.pinned ? 1 : 0) : l.pinned;
  db.prepare('UPDATE links SET title=?, url=?, hidden=?, pinned=? WHERE id=?').run(title, url, hidden, pinned, l.id);
  res.json({ link: linkRow(db.prepare('SELECT * FROM links WHERE id = ?').get(l.id)) });
});
app.delete('/api/links/:id', need, (req, res) => {
  db.prepare('DELETE FROM links WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------- public data + tracking ----------
app.get('/api/public/:username', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'Not found' });
  const links = db.prepare('SELECT id, title, pinned FROM links WHERE user_id = ? AND hidden = 0 ORDER BY pinned DESC, position ASC, id ASC').all(u.id)
    .map((l) => ({ id: l.id, title: l.title, pinned: !!l.pinned }));
  const total = db.prepare('SELECT COUNT(*) c FROM views WHERE user_id = ?').get(u.id).c;
  res.json({ username: u.username, uid: u.id, profile: parseProfile(u), badges: badgesFor(u), links, views: total });
});
app.post('/api/view/:username', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).end();
  if (req.user && req.user.id === u.id) return res.json({ counted: false });
  const visitor = crypto.createHash('sha256').update(req.ip + (req.headers['user-agent'] || '') + new Date().toISOString().slice(0, 10)).digest('hex').slice(0, 16);
  const recent = db.prepare('SELECT 1 FROM views WHERE user_id = ? AND visitor = ? AND ts > ?').get(u.id, visitor, now() - 30 * 60e3);
  if (recent || /bot|crawler|spider|preview/i.test(req.headers['user-agent'] || '')) return res.json({ counted: false });
  const host = (req.headers.host || '').split(':')[0];
  db.prepare('INSERT INTO views (user_id, ts, visitor, ref, device) VALUES (?, ?, ?, ?, ?)')
    .run(u.id, now(), visitor, refOf(str(req.body && req.body.ref, 500), host), deviceOf(req.headers['user-agent']));
  res.json({ counted: true });
});
app.get('/go/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM links WHERE id = ? AND hidden = 0').get(Number(req.params.id));
  if (!l) return res.status(404).send('Link not found');
  const ua = req.headers['user-agent'] || '';
  if (!/bot|crawler|spider/i.test(ua) && !(req.user && req.user.id === l.user_id)) {
    db.prepare('UPDATE links SET clicks = clicks + 1 WHERE id = ?').run(l.id);
    db.prepare('INSERT INTO clicks (user_id, link_id, ts) VALUES (?, ?, ?)').run(l.user_id, l.id, now());
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, l.url);
});

// ---------- analytics ----------
app.get('/api/analytics', need, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = now() - days * 86400e3;
  const uid = req.user.id;
  const views = db.prepare('SELECT ts, visitor, ref, device FROM views WHERE user_id = ? AND ts >= ?').all(uid, since);
  const clicks = db.prepare('SELECT ts, link_id FROM clicks WHERE user_id = ? AND ts >= ?').all(uid, since);
  const day = (ts) => new Date(ts + 4 * 3600e3).toISOString().slice(0, 10);
  const series = {};
  for (let i = days - 1; i >= 0; i--) series[day(now() - i * 86400e3)] = { views: 0, clicks: 0 };
  views.forEach((v) => { const d = day(v.ts); if (series[d]) series[d].views++; });
  clicks.forEach((c) => { const d = day(c.ts); if (series[d]) series[d].clicks++; });
  const count = (arr, key) => Object.entries(arr.reduce((a, x) => { a[x[key]] = (a[x[key]] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, count: n }));
  const topLinks = db.prepare('SELECT id, title, clicks FROM links WHERE user_id = ? ORDER BY clicks DESC LIMIT 8').all(uid);
  const totalViews = db.prepare('SELECT COUNT(*) c FROM views WHERE user_id = ?').get(uid).c;
  res.json({
    days, totals: { views: views.length, visitors: new Set(views.map((v) => v.visitor)).size, clicks: clicks.length, allTimeViews: totalViews,
      ctr: views.length ? Math.round((clicks.length / views.length) * 1000) / 10 : 0 },
    series: Object.entries(series).map(([date, v]) => ({ date, ...v })),
    sources: count(views, 'ref'), devices: count(views, 'device'), topLinks
  });
});

// ---------- ops ----------
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, schema: SCHEMA_VERSION, uptime: Math.round(process.uptime()), backup: backup.status() });
  } catch { res.status(503).json({ ok: false }); }
});
// Everything the platform stores about the signed-in user (no password hash, no session tokens).
app.get('/api/export', need, (req, res) => {
  const uid = req.user.id;
  const out = {
    exportedAt: new Date().toISOString(),
    account: { uid, username: req.user.username, email: req.user.email, createdAt: new Date(req.user.created_at).toISOString() },
    profile: parseProfile(req.user),
    links: db.prepare('SELECT id, title, url, position, hidden, pinned, clicks FROM links WHERE user_id = ? ORDER BY position, id').all(uid),
    views: db.prepare('SELECT ts, ref, device FROM views WHERE user_id = ? ORDER BY ts').all(uid),
    clicks: db.prepare('SELECT link_id, ts FROM clicks WHERE user_id = ? ORDER BY ts').all(uid)
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="nebu-${req.user.username}-export.json"`);
  res.end(JSON.stringify(out, null, 2));
});

// ---------- pages ----------
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: '1h' }));
app.get('/dashboard', (req, res) => (req.user ? res.sendFile(path.join(pub, 'dashboard.html')) : res.redirect('/login')));
app.get('/:username', (req, res, next) => {
  const u = req.params.username.toLowerCase();
  if (!USERNAME_RE.test(u)) return next();
  const row = db.prepare('SELECT username FROM users WHERE username = ?').get(u);
  if (!row) return res.status(404).sendFile(path.join(pub, '404.html'));
  res.sendFile(path.join(pub, 'profile.html'));
});
app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 400 ? 'Bad request' : 'Server error' });
});

if (require.main === module) {
  (async () => {
    // Restore from the GitHub snapshot BEFORE serving, and refuse to start if that is unsafe,
    // otherwise an empty database could later overwrite a good backup.
    try {
      const r = await backup.restore();
      if (backup.enabled) console.log('Backup:', r.restored ? `restored ${r.users} user(s) from GitHub snapshot` : r.reason);
    } catch (e) { console.error('Backup restore failed, not starting:', e.message); process.exit(1); }
    const server = app.listen(PORT, () => console.log(`Nebu running on http://localhost:${PORT} (schema v${SCHEMA_VERSION}, backup ${backup.enabled ? 'on' : 'off'})`));
    const stop = () => { // finish in-flight requests, push a last snapshot, then close the DB cleanly
      server.close(() => backup.flush().finally(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); }));
      setTimeout(() => process.exit(0), 15000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })();
}
module.exports = app;
