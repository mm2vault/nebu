'use strict';
/*
 * Encrypted snapshot backup to a (private!) GitHub repository.
 *
 *  - Every change marks the data dirty; a snapshot is written at most once per interval and on shutdown.
 *  - On boot, if the local database is empty, the latest snapshot is restored.
 *  - The snapshot is gzip-compressed and encrypted with AES-256-GCM before it leaves the server,
 *    so emails and password hashes never appear in plaintext in the repository.
 *  - Sessions are not backed up: after a restore people simply log in again.
 *
 * Enabled only when SNAPSHOT_REPO, GITHUB_TOKEN and SNAPSHOT_KEY are all set.
 * This is a stop-gap for hosts without a persistent disk. It assumes ONE running instance.
 */
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const TABLES = ['users', 'links', 'views', 'clicks'];
const MAGIC = Buffer.from('NEBU1');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = function createBackup(db, env = process.env) {
  const repo = env.SNAPSHOT_REPO;
  const token = env.GITHUB_TOKEN;
  const pass = env.SNAPSHOT_KEY;
  const enabled = !!(repo && token && pass);
  const branch = env.SNAPSHOT_BRANCH || 'main';
  const file = env.SNAPSHOT_PATH || 'nebu-snapshot.bin';
  const api = (env.SNAPSHOT_API || 'https://api.github.com').replace(/\/$/, '');
  const interval = Number(env.SNAPSHOT_INTERVAL_MS) || 120000;
  const key = enabled ? crypto.scryptSync(pass, 'nebu-snapshot-v1', 32) : null;
  const state = { enabled, lastSync: null, lastError: null, lastBytes: 0 };
  let sha = null; let lastHash = ''; let timer = null; let flushing = null; let writable = false;

  const fileUrl = () => `${api}/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`;
  async function gh(method, { body, accept, repoOnly } = {}) {
    const url = repoOnly ? `${api}/repos/${repo}` : fileUrl() + (method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : '');
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, 'User-Agent': 'nebu-backup', 'X-GitHub-Api-Version': '2022-11-28',
        Accept: accept || 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  }

  function dump() {
    const out = { v: 1, tables: {}, seq: {} };
    for (const t of TABLES) out.tables[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
    for (const r of db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()) out.seq[r.name] = r.seq;
    return JSON.stringify(out);
  }
  function encode(json) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(zlib.gzipSync(json)), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
  }
  function decode(buf) {
    if (buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw fatal('Snapshot file is not a Nebu snapshot');
    const iv = buf.subarray(5, 17); const tag = buf.subarray(17, 33);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
      return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(33)), d.final()])).toString());
    } catch { throw fatal('Cannot decrypt snapshot: SNAPSHOT_KEY is wrong or the file is corrupt'); }
  }
  function fatal(msg) { const e = new Error(msg); e.fatal = true; return e; }

  function load(data) {
    if (!data || data.v !== 1) throw fatal('Unsupported snapshot version');
    db.exec('BEGIN');
    try {
      for (const t of TABLES) {
        for (const row of data.tables[t] || []) {
          const cols = Object.keys(row);
          if (!cols.length || !cols.every((c) => /^[a-z_]+$/.test(c))) throw fatal('Bad column name in snapshot');
          db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
        }
      }
      for (const [name, seq] of Object.entries(data.seq || {})) { // keep AUTOINCREMENT counters so deleted UIDs are never reused
        if (!TABLES.includes(name)) continue;
        db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name);
        db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /** Run once before serving traffic. Throws if it is not safe to start (so the host restarts us). */
  async function restore() {
    if (!enabled) return { restored: false, reason: 'disabled' };
    const hasLocal = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const meta = await gh('GET');
        if (meta.status === 404) {
          const r = await gh('GET', { repoOnly: true });
          if (!r.ok) throw fatal(`Backup repo ${repo} not reachable (HTTP ${r.status}): check SNAPSHOT_REPO and that GITHUB_TOKEN can access it`);
          writable = true; return { restored: false, reason: 'no snapshot yet' };
        }
        if (!meta.ok) throw new Error(`GitHub HTTP ${meta.status}`);
        sha = (await meta.json()).sha;
        if (hasLocal) { writable = true; return { restored: false, reason: 'local data present' }; } // never overwrite local data with an older copy
        const raw = await gh('GET', { accept: 'application/vnd.github.raw+json' });
        if (!raw.ok) throw new Error(`GitHub HTTP ${raw.status}`);
        load(decode(Buffer.from(await raw.arrayBuffer())));
        lastHash = sha256(dump()); writable = true;
        return { restored: true, users: db.prepare('SELECT COUNT(*) c FROM users').get().c };
      } catch (e) {
        if (e.fatal) throw e;
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    throw new Error(`Could not read backup after 3 tries: ${lastErr && lastErr.message}`);
  }

  function schedule() {
    if (timer || !enabled) return;
    timer = setTimeout(() => { timer = null; flush(); }, interval);
    timer.unref();
  }
  function markDirty() { if (enabled && writable) schedule(); }

  function flush() {
    if (!enabled || !writable) return Promise.resolve();
    if (flushing) return flushing;
    clearTimeout(timer); timer = null;
    flushing = (async () => {
      try {
        const json = dump(); const h = sha256(json);
        if (h === lastHash) return;
        const buf = encode(json);
        const body = { message: `snapshot ${new Date().toISOString()}`, content: buf.toString('base64'), branch, ...(sha ? { sha } : {}) };
        let r = await gh('PUT', { body });
        if (r.status === 409 || r.status === 422) { // stale or missing sha: refetch once and retry
          const meta = await gh('GET');
          if (meta.ok) { body.sha = (await meta.json()).sha; r = await gh('PUT', { body }); }
        }
        if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
        sha = (await r.json()).content.sha; lastHash = h;
        state.lastSync = new Date().toISOString(); state.lastError = null; state.lastBytes = buf.length;
      } catch (e) { state.lastError = String(e.message || e); schedule(); } // try again next interval
      finally { flushing = null; }
    })();
    return flushing;
  }

  return { enabled, restore, markDirty, flush, status: () => ({ ...state }) };
};
