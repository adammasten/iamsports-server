// test_no_stale_key_refs.js
//
// GUARD: no RUNTIME reference to the removed JS constant SUPABASE_SERVICE_ROLE_KEY.
//
// WHY. Commit 6430937 renamed the privileged key constant to SUPABASE_SECRET_KEY but
// left two references behind inside resumableUpload(). Node does not catch that at
// startup — the identifier only blows up when the function actually runs — so the
// server booted fine, health returned 200, every auth test passed, and the failure
// surfaced only in production, at 70% of a real optimize:
//
//     "uploading: SUPABASE_SERVICE_ROLE_KEY is not defined"
//
// That silently broke /optimize, /concat-game, /faststart and
// /reel-faststart-backfill — every path that uploads through resumableUpload — while
// /export kept working, so the deploy looked healthy. One video burned 3 of its 5
// optimize attempts before anyone noticed.
//
// The env VARIABLE of the same name is still read once, deliberately, as the
// transitional fallback at the top of index.js. That single read is allowed; any other
// bare use of the identifier is the bug this file exists to prevent.
//
// Run: node test_no_stale_key_refs.js
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const LINES = SRC.split('\n');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; const m = `  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`; failures.push(m); console.log(m); }
}

// ── A. no stale runtime references ───────────────────────────────────────────
const stale = [];
LINES.forEach((line, idx) => {
  if (!line.includes('SUPABASE_SERVICE_ROLE_KEY')) return;
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*')) return;              // comment
  if (line.includes('process.env.SUPABASE_SERVICE_ROLE_KEY')) return; // allowed env read
  stale.push(`${idx + 1}: ${t.slice(0, 90)}`);
});
ok('no bare SUPABASE_SERVICE_ROLE_KEY identifier outside process.env', stale.length === 0, stale.join('\n          '));

// The env fallback is read EXACTLY once — more would mean the rename half-happened again.
const envReads = (SRC.match(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/g) || []).length;
ok('transitional env fallback present exactly once', envReads === 1, `found ${envReads}`);
ok('fallback still prefers the new var',
   /const SUPABASE_SECRET_KEY = process\.env\.SUPABASE_SECRET_KEY \|\| process\.env\.SUPABASE_SERVICE_ROLE_KEY;/.test(SRC));

// ── B. resumableUpload specifically ──────────────────────────────────────────
const start = SRC.indexOf('async function resumableUpload(');
ok('resumableUpload() exists', start > 0);
const body = SRC.slice(start, start + 2500);
ok('resumableUpload authorizes with SUPABASE_SECRET_KEY',
   /authorization: `Bearer \$\{SUPABASE_SECRET_KEY\}`/.test(body));
ok('resumableUpload sends apikey: SUPABASE_SECRET_KEY', /apikey: SUPABASE_SECRET_KEY/.test(body));
ok('resumableUpload contains NO stale identifier', !body.includes('SUPABASE_SERVICE_ROLE_KEY'));

// ── C. every identifier the module uses at runtime is actually declared ──────
// Catches the whole class of bug, not just this instance: any ALL_CAPS config-style
// identifier referenced in code must be declared somewhere.
const declared = new Set();
for (const m of SRC.matchAll(/\bconst\s+([A-Z][A-Z0-9_]{3,})\s*=/g)) declared.add(m[1]);
const used = new Set();
LINES.forEach((line) => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*')) return;
  // Strip STRING AND TEMPLATE LITERAL CONTENT first — log text like
  // "[auth] LEGACY unauthenticated" is prose, not an identifier, and counting it
  // produced false failures on the first run of this file.
  const noStrings = line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // keep ${...} interpolations, drop the literal text around them
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``')
    .replace(/`((?:[^`\\]|\\.)*)`/g, (_m, inner) =>
      (inner.match(/\$\{[^}]*\}/g) || []).join(' '));
  const noEnv = noStrings.replace(/process\.env\.[A-Z0-9_]+/g, '');
  for (const m of noEnv.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) used.add(m[1]);
});
// Node/JS globals and well-known non-config caps tokens that are never `const`-declared here.
const GLOBALS = new Set([
  'JSON','NaN','URL','URLSearchParams','TRUE','FALSE','NULL','GET','POST','PUT','DELETE','HEAD','OPTIONS',
  'PATCH','HTTP','HTTPS','UTF','MP4','JPEG','JPG','PNG','ETAG','TTL','ID','URI','API','OK','EPROTO','ENOENT',
  'AWS','S3','SQL','RLS','CORS','JWT','CPU','RAM','GB','MB','KB','UUID','ISO','UTC','MOV','HEVC','FPS','CFR',
  'IAMSPORTS','README','TODO','NOTE','WARNING','ERROR','INFO','DEBUG','SIGTERM','SIGINT','EACCES','ECONNRESET',
]);
const undeclared = [...used].filter(u => !declared.has(u) && !GLOBALS.has(u));
ok('every ALL_CAPS runtime identifier is declared', undeclared.length === 0,
   undeclared.length ? `undeclared: ${undeclared.join(', ')}` : '');

// ── D. the module parses and loads without throwing ─────────────────────────
try {
  new (require('node:vm').Script)(SRC, { filename: 'index.js' });
  ok('index.js parses cleanly', true);
} catch (e) {
  ok('index.js parses cleanly', false, String(e.message).slice(0, 120));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { console.log('\n' + failures.join('\n')); process.exit(1); }
