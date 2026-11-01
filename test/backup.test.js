const http = require('node:http'), crypto = require('node:crypto'), { spawn } = require('node:child_process'), fs = require('node:fs');
const NEBU = require('node:path').join(__dirname, '..', 'server.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock GitHub contents API ----
const gh = { file: null, sha: null, puts: 0, repoExists: true, forceStatus: 0 };
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const body = Buffer.concat(chunks).toString();
    const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'Bad credentials' });
    if (gh.forceStatus) return send(gh.forceStatus, { message: 'forced' });
    if (u.pathname === '/repos/me/data') return gh.repoExists ? send(200, {}) : send(404, {});
    if (u.pathname !== '/repos/me/data/contents/nebu-snapshot.bin') return send(404, {});
    if (!gh.repoExists) return send(404, {});
    if (req.method === 'GET') {
      if (!gh.file) return send(404, { message: 'Not Found' });
      if ((req.headers.accept || '').includes('raw')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(gh.file); }
      return send(200, { sha: gh.sha, size: gh.file.length });
    }
    if (req.method === 'PUT') {
      const b = JSON.parse(body);
      if (gh.file && !b.sha) return send(422, { message: 'sha wasn\'t supplied' });
      if (gh.file && b.sha !== gh.sha) return send(409, { message: 'does not match' });
      gh.file = Buffer.from(b.content, 'base64'); gh.sha = crypto.createHash('sha1').update(gh.file).digest('hex'); gh.puts++;
      return send(200, { content: { sha: gh.sha } });
    }
    send(405, {});
  });
});

function start(port, dir, extra = {}) {
  const env = { ...process.env, PORT: port, DATA_DIR: dir, SNAPSHOT_REPO: 'me/data', GITHUB_TOKEN: 'test-token', SNAPSHOT_KEY: 'correct horse battery',
    SNAPSHOT_API: 'http://localhost:4010', SNAPSHOT_INTERVAL_MS: '400', ...extra };
  const p = spawn('node', ['--no-warnings', NEBU], { env }); let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.getOut = () => out; p.exited = new Promise((r) => p.on('exit', (c) => r(c)));
  return p;
}
async function waitUp(port) { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://localhost:${port}/healthz`); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('server did not start'); }
const J = (port, method, path, body, cookie) => fetch(`http://localhost:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });

(async () => {
  await new Promise((r) => mock.listen(4010, r));
  for (const d of ['/tmp/bk1', '/tmp/bk2', '/tmp/bk3', '/tmp/bk4', '/tmp/bk5']) fs.rmSync(d, { recursive: true, force: true });

  // 1. first run, no snapshot yet
  let s = start(3120, '/tmp/bk1'); let h = await waitUp(3120);
  ok(h.backup.enabled === true, 'backup enabled on first run'); ok(/no snapshot yet/.test(s.getOut()), 'first boot reports "no snapshot yet"');

  // 2. signups + link -> snapshots appear, encrypted
  let r = await J(3120, 'POST', '/api/signup', { username: 'alice', email: 'alice@example.com', password: 'password123' }); const cookie = r.headers.get('set-cookie').split(';')[0];
  await sleep(1200);
  ok(gh.puts >= 1, `snapshot written after signup (puts=${gh.puts})`);
  const txt = gh.file.toString('latin1');
  ok(!txt.includes('alice') && !txt.includes('example.com') && !txt.includes('password'), 'snapshot contains no plaintext username/email');
  ok(gh.file.subarray(0, 5).toString() === 'NEBU1', 'snapshot has NEBU1 header');
  await J(3120, 'POST', '/api/links', { title: 'GitHub', url: 'github.com/alice' }, cookie); await sleep(1200);
  const putsAfterLink = gh.puts; ok(putsAfterLink >= 2, 'link change produced a new snapshot');
  for (let i = 0; i < 5; i++) await fetch('http://localhost:3120/api/public/alice'); await sleep(1000);
  ok(gh.puts === putsAfterLink, 'read-only traffic produces no new snapshot');
  h = await (await fetch('http://localhost:3120/healthz')).json(); ok(!!h.backup.lastSync && h.backup.lastError === null, 'healthz shows lastSync and no error');

  // 3. signup right before shutdown -> shutdown flush must capture it
  await J(3120, 'POST', '/api/signup', { username: 'bob', email: 'bob@example.com', password: 'password456' });
  s.kill('SIGTERM'); const code = await s.exited; ok(code === 0, 'clean exit on SIGTERM');

  // 4. disk wiped (new empty dir) -> restore from snapshot
  s = start(3121, '/tmp/bk2'); h = await waitUp(3121);
  ok(/restored 2 user/.test(s.getOut()), 'restored both users after disk wipe: ' + s.getOut().split('\n').find((l) => l.includes('Backup')));
  const pa = await (await fetch('http://localhost:3121/api/public/alice')).json(); const pb = await fetch('http://localhost:3121/api/public/bob');
  console.log('   alice restored ->', JSON.stringify({ uid: pa.uid, links: pa.links.map((l) => l.title) })); ok(pa.username === 'alice' && pa.uid === 1 && pa.links.map((l) => l.title).join() === 'My website,GitHub', 'alice, UID and both links restored (default + added)'); ok(pb.status === 200, 'bob (signed up just before shutdown) restored');
  r = await J(3121, 'POST', '/api/login', { login: 'alice@example.com', password: 'password123' }); ok(r.status === 200, 'alice can log in with her old password');
  r = await J(3121, 'POST', '/api/login', { login: 'alice', password: 'wrongwrong' }); ok(r.status === 401, 'wrong password still rejected');
  r = await J(3121, 'POST', '/api/signup', { username: 'carol', email: 'carol@example.com', password: 'password789' }); const c = await r.json(); ok(c.user && c.user.uid === 3, 'next UID continues at 3 (counter restored)');
  s.kill('SIGTERM'); await s.exited;

  // 5. wrong key -> refuses to start (never overwrites)
  const before = gh.file.toString('hex');
  s = start(3122, '/tmp/bk3', { SNAPSHOT_KEY: 'wrong key' }); ok((await s.exited) === 1 && /decrypt/i.test(s.getOut()), 'wrong SNAPSHOT_KEY: refuses to start with clear message');
  ok(gh.file.toString('hex') === before, 'remote snapshot untouched after failed start');

  // 6. GitHub down on boot -> refuses to start after retries
  gh.forceStatus = 500; const t0 = Date.now(); s = start(3123, '/tmp/bk4'); ok((await s.exited) === 1 && /Could not read backup/.test(s.getOut()), `GitHub 500 on boot: refuses to start (after ${Math.round((Date.now() - t0) / 1000)}s of retries)`);
  gh.forceStatus = 0;

  // 7. repo missing / token without access -> refuses to start
  gh.repoExists = false; s = start(3124, '/tmp/bk5'); ok((await s.exited) === 1 && /not reachable/.test(s.getOut()), 'missing repo: refuses to start with clear message'); gh.repoExists = true;

  // 8. GitHub fails while running -> app keeps serving, reports error, recovers
  s = start(3125, '/tmp/bk2'); await waitUp(3125);
  ok(/local data present/.test(s.getOut()), 'existing local data is never overwritten by an older remote copy');
  gh.forceStatus = 500; await J(3125, 'POST', '/api/signup', { username: 'dave', email: 'dave@example.com', password: 'password000' }); await sleep(1200);
  h = await (await fetch('http://localhost:3125/healthz')).json(); ok(h.ok && !!h.backup.lastError, 'GitHub outage: site stays up, healthz reports lastError');
  gh.forceStatus = 0; await sleep(1500); h = await (await fetch('http://localhost:3125/healthz')).json(); ok(h.backup.lastError === null, 'recovers automatically when GitHub is back');
  s.kill('SIGTERM'); await s.exited;

  // 9. backup disabled when not configured
  s = start(3126, '/tmp/bk5', { SNAPSHOT_REPO: '' }); h = await waitUp(3126); ok(h.backup.enabled === false, 'disabled cleanly when env vars are missing'); s.kill('SIGTERM'); await s.exited;

  console.log(`\n${pass} passed, ${fail} failed`); mock.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
