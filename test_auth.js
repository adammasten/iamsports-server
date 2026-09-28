// test_auth.js — Railway media-server authorization contract.
//
// Run: node test_auth.js
//
// SAFETY. The server under test is booted with SUPABASE_URL pointed at a dead
// localhost port and dummy keys, so NO production Supabase call, storage read,
// storage delete or ffmpeg backfill can possibly occur. Nothing here touches the
// real project. That is deliberate: these are authorization tests, and proving a
// destructive route is REACHABLE must never mean actually running it.
//
// WHAT THIS CANNOT COVER. Accepting a genuinely valid user JWT requires a live
// Supabase and a real session, so the happy path is proven by the post-deploy smoke
// test, not here. Everything that must FAIL CLOSED is proven here.
const { spawn } = require('node:child_process');

const PORT = 39117;
const BASE = `http://127.0.0.1:${PORT}`;
const OP_SECRET = 'test-operator-secret-value-0123456789';

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  if (String(got) === String(want)) { pass++; console.log(`  PASS  ${name} → ${got}`); }
  else { fail++; const m = `  FAIL  ${name}\n          got:  ${got}\n          want: ${want}`; failures.push(m); console.log(m); }
}

async function req(method, path, { token, opSecret, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token !== undefined) headers.Authorization = token;
  if (opSecret !== undefined) headers['x-operator-secret'] = opSecret;
  try {
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.status;
  } catch (e) { return `NETERR:${e.message}`; }
}

function boot(env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        // Dead port: every Supabase call fails fast and harmlessly.
        SUPABASE_URL: 'http://127.0.0.1:9',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-not-real',
        SUPABASE_PUBLISHABLE_KEY: 'dummy-publishable-not-real',
        OPERATOR_SECRET: OP_SECRET,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('running on port')) resolve({ child, out: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error(`server did not start (${label}): ${out}`)), 15000);
  });
}

(async () => {
  // ══ PHASE A: enforcement ON (the Phase-4 end state) ══
  console.log('\n=== A. REQUIRE_USER_AUTH=true — user routes must deny ===');
  let s = await boot({ REQUIRE_USER_AUTH: 'true' }, 'enforcing');

  // 1. unauthenticated
  check('1  POST /export        no auth', await req('POST', '/export', { body: { clips: [{ url: 'k', start_time: 0, end_time: 1 }] } }), 401);
  check('1b POST /concat-game   no auth', await req('POST', '/concat-game', { body: { keys: ['k'] } }), 401);
  check('1c POST /optimize      no auth', await req('POST', '/optimize', { body: { key: 'k' } }), 401);
  check('1d POST /reel-thumbnail no auth', await req('POST', '/reel-thumbnail', { body: { reelId: 'r' } }), 401);
  check('1e GET  /job/:id       no auth', await req('GET', '/job/abc'), 401);

  // 2. malformed Authorization headers
  check('2  malformed: bare token', await req('POST', '/export', { token: 'not-a-bearer', body: { clips: [{ url: 'k' }] } }), 401);
  check('2b malformed: empty Bearer', await req('POST', '/export', { token: 'Bearer', body: { clips: [{ url: 'k' }] } }), 401);
  check('2c malformed: Bearer only spaces', await req('POST', '/export', { token: 'Bearer    ', body: { clips: [{ url: 'k' }] } }), 401);
  check('2d wrong scheme: Basic', await req('POST', '/export', { token: 'Basic abc123', body: { clips: [{ url: 'k' }] } }), 401);

  // 3. invalid / expired signature — an unverifiable token is rejected, never trusted.
  const EXPIRED = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjE1MTYyMzkwMjJ9.badsignaturebadsignaturebadsignature';
  check('3  expired/invalid JWT', await req('POST', '/export', { token: `Bearer ${EXPIRED}`, body: { clips: [{ url: 'k' }] } }), 401);
  check('3b garbage JWT', await req('POST', '/export', { token: 'Bearer aaa.bbb.ccc', body: { clips: [{ url: 'k' }] } }), 401);
  // A user id in the BODY must never be trusted as identity.
  check('3c body-supplied user id is ignored', await req('POST', '/export', { body: { userId: '7f1122bd-f2e6-4006-adf7-728ff3709cc5', clips: [{ url: 'k' }] } }), 401);

  // 6. arbitrary storage key cannot bypass authorization (no token → never reaches ffmpeg)
  check('6  arbitrary storage key, no auth', await req('POST', '/export', { body: { clips: [{ url: 'team-someoneelse-123-0.mp4', start_time: 0, end_time: 5 }] } }), 401);
  check('6b arbitrary key via /concat-game', await req('POST', '/concat-game', { body: { keys: ['team-someoneelse-123-0.mp4'] } }), 401);

  // 7. another user's job id is not readable (also: unknown id must not be confirmed)
  check('7  unknown job id, no auth', await req('GET', '/job/deadbeefdeadbeefdeadbeefdeadbeef'), 401);

  // ══ ADMIN / OPERATOR ROUTES — deny regardless of the rollout flag ══
  console.log('\n=== B. operator routes ===');
  const OPS = ['/optimize-all', '/thumbnails-backfill', '/reel-faststart-backfill', '/reel-thumbnails-backfill', '/faststart'];
  for (const r of OPS) {
    // 9. unauthenticated
    check(`9  ${r} no auth`, await req('POST', r, { body: {} }), 401);
    // 11. wrong secret
    check(`11 ${r} wrong secret`, await req('POST', r, { opSecret: 'wrong-secret-value', body: {} }), 401);
    // 11b. right length, wrong bytes (exercises the constant-time compare path)
    check(`11b ${r} same-length wrong secret`, await req('POST', r, { opSecret: 'x'.repeat(OP_SECRET.length), body: {} }), 401);
  }
  // 10. an ordinary user JWT must NOT open an operator route.
  check('10 operator route with a user Bearer token', await req('POST', '/optimize-all', { token: `Bearer ${EXPIRED}`, body: {} }), 401);

  // 12. correct operator auth is ACCEPTED. /faststart needs a `key`; omitting it means
  //     we get the handler's own 400 — proof we passed the middleware WITHOUT starting
  //     any real work. A 200/202 here would mean a job actually launched.
  check('12 correct operator secret reaches the handler', await req('POST', '/faststart', { opSecret: OP_SECRET, body: {} }), 400);

  // ══ /optimize DUAL AUTH — user JWT OR operator secret, never anonymous ══
  console.log('\n=== B2. /optimize dual auth (app user OR DB sweep cron) ===');
  // The DB sweep (public.sweep_stalled_optimizes) presents the operator secret, not a JWT.
  // 400 = it passed the middleware and hit the handler's own "no key" validation, without
  // starting any real ffmpeg work.
  check('D1 /optimize with operator secret, no body', await req('POST', '/optimize', { opSecret: OP_SECRET, body: {} }), 400);
  // A wrong operator secret must NOT fall through to the user path and must not be allowed.
  check('D2 /optimize wrong operator secret', await req('POST', '/optimize', { opSecret: 'nope', body: { key: 'k' } }), 401);
  check('D3 /optimize same-length wrong secret', await req('POST', '/optimize', { opSecret: 'x'.repeat(OP_SECRET.length), body: { key: 'k' } }), 401);
  // No anonymous third path.
  check('D4 /optimize anonymous denied', await req('POST', '/optimize', { body: { key: 'k' } }), 401);
  check('D5 /optimize bad user JWT denied', await req('POST', '/optimize', { token: `Bearer ${EXPIRED}`, body: { key: 'k' } }), 401);
  // Presenting an EMPTY operator header must not be treated as "no header" and fall through.
  check('D6 /optimize empty operator header denied', await req('POST', '/optimize', { opSecret: '', body: { key: 'k' } }), 401);

  // health check stays open
  check('   GET / health is public', await req('GET', '/'), 200);

  s.child.kill('SIGKILL');

  // ══ PHASE C: rollout flag OFF — old builds still work, but a PRESENT token is still verified ══
  console.log('\n=== C. REQUIRE_USER_AUTH=false (staged rollout) ===');
  s = await boot({ REQUIRE_USER_AUTH: 'false' }, 'legacy');
  // Legacy client with no header is allowed through (this is the temporary state).
  const legacyExport = await req('POST', '/export', { body: { clips: [{ url: 'k', start_time: 0, end_time: 1 }] } });
  check('C1 legacy no-auth /export still accepted', legacyExport, 200);
  // But a BAD token is STILL rejected even with the flag off — opportunistic enforcement.
  check('C2 bad token rejected even with flag off', await req('POST', '/export', { token: `Bearer ${EXPIRED}`, body: { clips: [{ url: 'k' }] } }), 401);
  // Operator routes are gated regardless of the flag — this is the immediate containment.
  check('C3 operator route gated with flag off', await req('POST', '/optimize-all', { body: {} }), 401);
  check('C4 operator route gated, wrong secret, flag off', await req('POST', '/faststart', { opSecret: 'nope', body: { key: 'k' } }), 401);
  s.child.kill('SIGKILL');

  // ══ PHASE D: no OPERATOR_SECRET configured → operator routes are closed, not open ══
  console.log('\n=== D. OPERATOR_SECRET unset — fail closed ===');
  s = await boot({ REQUIRE_USER_AUTH: 'true', OPERATOR_SECRET: '' }, 'no-secret');
  check('D1 operator route with no secret configured', await req('POST', '/optimize-all', { body: {} }), 503);
  check('D2 cannot be opened by sending an empty secret', await req('POST', '/optimize-all', { opSecret: '', body: {} }), 503);
  s.child.kill('SIGKILL');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
