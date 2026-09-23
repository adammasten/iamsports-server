const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ffmpeg's real complaint ("unsupported codec", "moov atom not found", …) goes to
// the command's stdout — every ffmpeg call here ends in `2>&1`. Node builds
// error.message from the command plus *stderr*, which those redirects leave
// empty, so a transcode failure arrived as "Command failed: ffmpeg …" and
// nothing else. Append the tail of the captured output so the job error says why.
function withCmdOutput(error) {
  const out = String(error?.stdout || error?.stderr || '').trim();
  if (!out) return error?.message || String(error);
  const head = String(error?.message || '').split('\n')[0];
  const tail = out.length > 1500 ? `...${out.slice(-1500)}` : out;
  return `${head}\n${tail}`;
}
const fs = require('fs');
const https = require('https');
const os = require('os');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wscfpkaltajnrhiusoze.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const jobs = {};

// Keys currently being optimized → the jobId that owns them. /optimize has no
// other dedupe: processOptimize downloads + transcodes + uploads unconditionally,
// so two calls for the same key (client kickoff racing a sweep or a manual retry)
// would run TWO full ffmpeg passes on one container. In-memory like `jobs`, so a
// restart clears it — that's correct, the job it tracked died with the container.
const activeOptimizeKeys = new Map();

// Signed-URL lifetimes (seconds). Source URLs only need to outlive a single
// download (downloadFile caps at 30 min); 1h gives margin. The output URL is
// handed to the client to save to the camera roll — 24h so an offline or
// delayed retry doesn't lose the export.
const SOURCE_URL_TTL_SECONDS = 3600;   // 1 hour
const OUTPUT_URL_TTL_SECONDS = 86400;  // 24 hours

app.get('/', (req, res) => {
  res.json({ status: 'IamSports server running!', supabaseConnected: !!SUPABASE_URL, faststart: 'resumable-v3', optimize: 'v3-idempotent' });
});

app.post('/export', async (req, res) => {
  try {
    const { clips, outputFileName } = req.body;
    if (!clips || clips.length === 0) {
      return res.status(400).json({ error: 'No clips provided' });
    }
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing',
      url: null,
      error: null,
      progress: 0,
      stage: 'starting',
      phaseItem: null,
      phaseTotal: null,
      label: 'Queued...',
      createdAt: Date.now(),
    };
    res.json({ jobId });
    processExport(jobId, clips, outputFileName).catch((e) => console.error(`[${jobId}] processExport rejected:`, e?.message || e));
  } catch (e) {
    console.error('Export endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Faststart (web-optimize a raw game video) ────────────────────────────────
// iPhone recordings put the MP4 index (moov atom) at the END of the file, so a
// player can't start streaming until it fetches the whole thing — which is why
// big games "won't play from the cloud" while a downloaded copy plays fine
// (reels now stream on web too: the /export concat includes +faststart; run
//  /reel-faststart-backfill once to fix reels rendered before that.)
// This does the same lossless remux (-c copy, no re-encode, no quality loss),
// moving the index to the front, uploads it to a NEW key, repoints videos.url to
// it, and deletes the old object (a fresh key avoids the overwrite 409 and never
// risks the original). Poll /job/:id like /export.
//
// Big-file safe: download streams to disk (downloadFile), and the re-upload uses
// Supabase's resumable (TUS) endpoint in 15MB chunks read from disk (NOT a
// single POST / fs.readFileSync — a multi-GB body gets reset by the gateway
// with 'write EPROTO', and a 4.75GB Buffer would OOM the container).
app.post('/faststart', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'No storage key provided' });
    }
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'starting', phaseItem: null, phaseTotal: null,
      label: 'Queued...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processFaststart(jobId, key).catch((e) => console.error(`[${jobId}] processFaststart rejected:`, e?.message || e));
  } catch (e) {
    console.error('Faststart endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Concat game (stitch a game's videos into ONE downloadable file) ──────────
// ADDITIVE — does not touch /export or any reel. Takes a game's video KEYS in
// play order, NORMALIZES each to a uniform 720p H.264 profile (so a -c copy
// concat is glitch-free even when quarters have mismatched codecs — raw HEVC and
// already-optimized 720p mixed in one game), concatenates with +faststart,
// uploads the result to a fresh game-downloads/ key, and returns a 24h signed
// URL via /job/:id (exactly like /export). Nothing is repointed or deleted — the
// source videos are never touched.
//
// Memory/disk safe: each source streams to disk (downloadFile), is normalized,
// and the raw source is DELETED before the next download (peak disk = 1 raw +
// N small 720p + output). The upload uses resumableUpload (15MB chunks from
// disk) — no multi-GB Buffer / single POST, so a full game can't OOM the box.
//
// SPEED NOTE: this re-encodes each full video (the cost of one glitch-free file).
// "Download all videos" stays the fast, no-re-encode path; this is the optional
// single-file convenience.
app.post('/concat-game', async (req, res) => {
  try {
    const { keys, outputFileName } = req.body;
    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'No video keys provided' });
    }
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'starting', phaseItem: null, phaseTotal: null,
      label: 'Queued...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processConcatGame(jobId, keys, outputFileName).catch((e) => console.error(`[${jobId}] processConcatGame rejected:`, e?.message || e));
  } catch (e) {
    console.error('Concat-game endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Optimize (transcode raw game video → streamable 720p H.264) ───────────────
// Faststart alone wasn't enough: iPhone games are HEVC (often HDR), which the
// in-app player stalls/blacks on, and at 4.75GB they stream poorly. This makes a
// small, universally-playable copy WITHOUT destroying the master:
//   1. download the current file (videos.url = the full-quality master)
//   2. transcode → 720p H.264 (yuv420p / SDR-safe), faststart
//   3. upload the small copy to a NEW key
//   4. videos.original_url := old url (master, kept), videos.url := new key
// Playback then uses videos.url (the small copy) with no app change; the master
// stays in original_url for full-quality download/export. Nothing is deleted.
// Poll /job/:id. Requires the videos.original_url column to exist.
app.post('/optimize', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'No storage key provided' });
    }
    // GUARD A (fast path): this key is already being optimized → hand back the
    // job that owns it. Checking jobs[inFlight] too so a stale entry can't block
    // the key forever.
    const inFlight = activeOptimizeKeys.get(key);
    if (inFlight && jobs[inFlight]) {
      console.log(`[optimize] duplicate request for ${key} → returning in-flight job ${inFlight}`);
      return res.json({ jobId: inFlight, deduped: true });
    }
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'starting', phaseItem: null, phaseTotal: null,
      label: 'Queued...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processOptimize(jobId, key).catch((e) => console.error(`[${jobId}] processOptimize rejected:`, e?.message || e));
  } catch (e) {
    console.error('Optimize endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Batch: optimize every video not yet optimized (original_url is null), one at a
// time (sequential — never two CPU-heavy transcodes at once). Idempotent: a
// re-run only picks up whatever's still pending, so it's safe to fire again if it
// gets interrupted. Poll /job/:id for phaseItem/phaseTotal progress.
app.post('/optimize-all', async (req, res) => {
  try {
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'listing', phaseItem: null, phaseTotal: null,
      label: 'Finding videos to optimize...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processOptimizeAll(jobId).catch((e) => console.error(`[${jobId}] processOptimizeAll rejected:`, e?.message || e));
  } catch (e) {
    console.error('Optimize-all endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function processOptimizeAll(jobId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data: pending, error } = await supabase
      .from('videos').select('url, label').is('original_url', null).order('created_at');
    if (error) throw new Error(`list failed: ${error.message}`);
    const list = (pending || []).filter(v => v.url);
    jobs[jobId].phaseTotal = list.length;
    jobs[jobId].stage = 'optimizing';
    console.log(`[${jobId}] optimize-all: ${list.length} pending`);
    if (list.length === 0) {
      jobs[jobId].status = 'done'; jobs[jobId].progress = 100; jobs[jobId].label = 'Nothing to optimize';
      return;
    }
    let done = 0, failed = 0; const failures = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].progress = Math.round((i / list.length) * 100);
      jobs[jobId].label = `Optimizing ${i + 1}/${list.length}: ${v.label || v.url}`;
      const subId = `${jobId}-${i}`;
      jobs[subId] = { status: 'processing', stage: 'starting', progress: 0, error: null, createdAt: Date.now() };
      try { await processOptimize(subId, v.url); } catch (e) { /* processOptimize handles its own errors */ }
      if (jobs[subId] && jobs[subId].status === 'done') done++;
      else { failed++; failures.push(`${v.label || v.url}: ${jobs[subId] && jobs[subId].error || 'unknown'}`); }
      delete jobs[subId];
      if (!jobs[jobId]) return; // batch job was TTL-cleaned (very long run) — stop gracefully; re-run continues
    }
    jobs[jobId].status = failed === 0 ? 'done' : 'partial';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = `Optimized ${done}/${list.length}${failed ? ` (${failed} failed)` : ''}`;
    jobs[jobId].error = failures.length ? failures.join(' | ') : null;
    console.log(`[${jobId}] optimize-all done: ${done} ok, ${failed} failed`);
  } catch (e) {
    if (jobs[jobId]) { jobs[jobId].status = 'failed'; jobs[jobId].error = e.message; }
    console.error(`[${jobId}] optimize-all failed:`, e.message);
  }
}

// Batch: backfill a poster thumbnail for every video MISSING one (thumbnail_path
// is null). Independent of optimize — this fills the EXISTING library (rows that
// were optimized before the thumbnail step existed, which /optimize-all skips
// because their original_url is already set). Grabs a frame from each video's
// current url (the small 720p copy for optimized rows), uploads thumbnails/<id>.jpg,
// sets thumbnail_path. Sequential + idempotent (a re-run only picks up whatever's
// still null). Poll /job/:id for phaseItem/phaseTotal.
app.post('/thumbnails-backfill', async (req, res) => {
  try {
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'listing', phaseItem: null, phaseTotal: null,
      label: 'Finding videos without a thumbnail...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processThumbnailBackfill(jobId).catch((e) => console.error(`[${jobId}] processThumbnailBackfill rejected:`, e?.message || e));
  } catch (e) {
    console.error('Thumbnails-backfill endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function processThumbnailBackfill(jobId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data: pending, error } = await supabase
      .from('videos').select('id, url, label').is('thumbnail_path', null).order('created_at');
    if (error) throw new Error(`list failed: ${error.message}`);
    const list = (pending || []).filter(v => v.url);
    jobs[jobId].phaseTotal = list.length;
    jobs[jobId].stage = 'thumbnailing';
    console.log(`[${jobId}] thumbnails-backfill: ${list.length} missing`);
    if (list.length === 0) {
      jobs[jobId].status = 'done'; jobs[jobId].progress = 100; jobs[jobId].label = 'Every video already has a thumbnail';
      return;
    }
    let done = 0, failed = 0; const failures = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].progress = Math.round((i / list.length) * 100);
      jobs[jobId].label = `Thumbnailing ${i + 1}/${list.length}: ${v.label || v.url}`;
      try {
        await generateThumbnail(supabase, jobId, v.id, v.url);
        done++;
      } catch (e) {
        failed++; failures.push(`${v.label || v.url}: ${e.message}`);
        console.warn(`[${jobId}] thumbnail failed for ${v.url}: ${e.message}`);
      }
      if (!jobs[jobId]) return; // TTL-cleaned on a very long run — stop; a re-run continues
    }
    jobs[jobId].status = failed === 0 ? 'done' : 'partial';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = `Thumbnailed ${done}/${list.length}${failed ? ` (${failed} failed)` : ''}`;
    jobs[jobId].error = failures.length ? failures.join(' | ') : null;
    console.log(`[${jobId}] thumbnails-backfill done: ${done} ok, ${failed} failed`);
  } catch (e) {
    if (jobs[jobId]) { jobs[jobId].status = 'failed'; jobs[jobId].error = e.message; }
    console.error(`[${jobId}] thumbnails-backfill failed:`, e.message);
  }
}

// Download a video's current playback file, grab a representative frame (skipping
// the black camera-start), upload thumbnails/<id>.jpg, set videos.thumbnail_path.
// Throws on failure so the batch can count it; cleans its tmp dir either way.
async function generateThumbnail(supabase, jobId, videoId, key) {
  const tmpDir = `/tmp/thumb_${jobId}_${videoId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcPath = `${tmpDir}/src.mp4`;
  const thumbPath = `${tmpDir}/thumb.jpg`;
  try {
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    await execAsync(
      `ffmpeg -ss 1 -i ${srcPath} -vf "thumbnail=100,scale=640:-2" -frames:v 1 -q:v 3 ${thumbPath} -y 2>&1`,
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const thumbKey = `thumbnails/${videoId}.jpg`;
    const buf = fs.readFileSync(thumbPath);
    const { error: upErr } = await supabase.storage.from('Videos').upload(thumbKey, buf, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const { error: dbErr } = await supabase.from('videos').update({ thumbnail_path: thumbKey }).eq('id', videoId);
    if (dbErr) throw new Error(`DB set failed: ${dbErr.message}`);
    console.log(`[${jobId}] Thumbnail set: ${thumbKey}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── Reel thumbnails ─────────────────────────────────────────────────────────
// Reels are rendered by /export (not optimized), so they need their own poster
// step. Same idea as videos: grab a frame from the reel mp4, upload
// reel-thumbnails/<reelId>.jpg, set highlight_reels.thumbnail_path. Keyed by reel
// id so sign-media can authorize via authorize_reel_playback. Reels open on real
// play content (no black camera-start), so no -ss skip.
async function generateReelThumbnail(supabase, jobId, reelId, key) {
  const tmpDir = `/tmp/rthumb_${jobId}_${reelId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcPath = `${tmpDir}/src.mp4`;
  const thumbPath = `${tmpDir}/thumb.jpg`;
  try {
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    await execAsync(
      `ffmpeg -i ${srcPath} -vf "thumbnail=100,scale=640:-2" -frames:v 1 -q:v 3 ${thumbPath} -y 2>&1`,
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const thumbKey = `reel-thumbnails/${reelId}.jpg`;
    const buf = fs.readFileSync(thumbPath);
    const { error: upErr } = await supabase.storage.from('Videos').upload(thumbKey, buf, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const { error: dbErr } = await supabase.from('highlight_reels').update({ thumbnail_path: thumbKey }).eq('id', reelId);
    if (dbErr) throw new Error(`DB set failed: ${dbErr.message}`);
    console.log(`[${jobId}] Reel thumbnail set: ${thumbKey}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── Reel faststart backfill ─────────────────────────────────────────────────
// Reels rendered before the /export concat learned +faststart have their moov
// index at the END, so browsers can't stream them (they play on native, not web).
// Re-mux each with faststart (-c copy, no re-encode) and repoint storage_path.
// shares reference the reel id and resolve storage_path live, so the repoint is safe.
async function faststartReel(supabase, jobId, reelId, key) {
  const tmpDir = `/tmp/rfs_${jobId}_${reelId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcPath = `${tmpDir}/src.mp4`;
  const outPath = `${tmpDir}/out.mp4`;
  try {
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    await execAsync(`ffmpeg -i ${srcPath} -c copy -movflags +faststart -map 0 ${outPath} -y 2>&1`, { maxBuffer: 10 * 1024 * 1024 });
    const outSize = fs.statSync(outPath).size;
    const newKey = `${key.replace(/\.mp4$/i, '')}-fs${Date.now()}.mp4`;
    await resumableUpload(outPath, newKey, outSize, () => {});
    const { error: dbErr } = await supabase.from('highlight_reels').update({ storage_path: newKey }).eq('id', reelId);
    if (dbErr) throw new Error(`DB repoint failed: ${dbErr.message}`);
    try { await supabase.storage.from('Videos').remove([key]); } catch (e) {}
    console.log(`[${jobId}] Reel faststart: ${key} -> ${newKey}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

app.post('/reel-faststart-backfill', async (req, res) => {
  try {
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'listing', phaseItem: null, phaseTotal: null,
      label: 'Finding reels to faststart...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processReelFaststartBackfill(jobId).catch((e) => console.error(`[${jobId}] processReelFaststartBackfill rejected:`, e?.message || e));
  } catch (e) {
    console.error('Reel-faststart-backfill endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function processReelFaststartBackfill(jobId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data: reels, error } = await supabase.from('highlight_reels').select('id, storage_path, name').order('created_at');
    if (error) throw new Error(`list failed: ${error.message}`);
    const list = (reels || []).filter(r => r.storage_path);
    jobs[jobId].phaseTotal = list.length;
    jobs[jobId].stage = 'faststarting';
    console.log(`[${jobId}] reel-faststart-backfill: ${list.length} reels`);
    if (list.length === 0) { jobs[jobId].status = 'done'; jobs[jobId].progress = 100; jobs[jobId].label = 'No reels'; return; }
    let done = 0, failed = 0; const failures = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].progress = Math.round((i / list.length) * 100);
      jobs[jobId].label = `Faststarting reel ${i + 1}/${list.length}: ${r.name || r.id}`;
      try { await faststartReel(supabase, jobId, r.id, r.storage_path); done++; }
      catch (e) { failed++; failures.push(`${r.name || r.id}: ${e.message}`); console.warn(`[${jobId}] reel faststart failed for ${r.id}: ${e.message}`); }
      if (!jobs[jobId]) return;
    }
    jobs[jobId].status = failed === 0 ? 'done' : 'partial';
    jobs[jobId].progress = 100; jobs[jobId].stage = 'done';
    jobs[jobId].label = `Faststarted ${done}/${list.length}${failed ? ` (${failed} failed)` : ''}`;
    jobs[jobId].error = failures.length ? failures.join(' | ') : null;
    console.log(`[${jobId}] reel-faststart-backfill done: ${done} ok, ${failed} failed`);
  } catch (e) {
    if (jobs[jobId]) { jobs[jobId].status = 'failed'; jobs[jobId].error = e.message; }
    console.error(`[${jobId}] reel-faststart-backfill failed:`, e.message);
  }
}

// Fire-and-forget single reel thumbnail — the client calls this right after it
// creates a reel row. Best-effort: a failure just leaves the placeholder.
app.post('/reel-thumbnail', async (req, res) => {
  const { reelId } = req.body || {};
  if (!reelId) return res.status(400).json({ error: 'reelId required' });
  res.json({ ok: true });
  const jobId = `reelthumb_${reelId}`;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: reel, error } = await supabase.from('highlight_reels').select('storage_path').eq('id', reelId).maybeSingle();
    if (error || !reel?.storage_path) { console.warn(`[${jobId}] reel not found / no storage_path`); return; }
    await generateReelThumbnail(supabase, jobId, reelId, reel.storage_path);
  } catch (e) {
    console.warn(`[${jobId}] reel thumbnail failed (non-fatal): ${e.message}`);
  }
});

// Batch: backfill a poster for every reel missing one. Poll /job/:id.
app.post('/reel-thumbnails-backfill', async (req, res) => {
  try {
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'listing', phaseItem: null, phaseTotal: null,
      label: 'Finding reels without a thumbnail...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processReelThumbnailBackfill(jobId).catch((e) => console.error(`[${jobId}] processReelThumbnailBackfill rejected:`, e?.message || e));
  } catch (e) {
    console.error('Reel-thumbnails-backfill endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function processReelThumbnailBackfill(jobId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data: pending, error } = await supabase
      .from('highlight_reels').select('id, storage_path, name').is('thumbnail_path', null).order('created_at');
    if (error) throw new Error(`list failed: ${error.message}`);
    const list = (pending || []).filter(r => r.storage_path);
    jobs[jobId].phaseTotal = list.length;
    jobs[jobId].stage = 'thumbnailing';
    console.log(`[${jobId}] reel-thumbnails-backfill: ${list.length} missing`);
    if (list.length === 0) {
      jobs[jobId].status = 'done'; jobs[jobId].progress = 100; jobs[jobId].label = 'Every reel already has a thumbnail';
      return;
    }
    let done = 0, failed = 0; const failures = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].progress = Math.round((i / list.length) * 100);
      jobs[jobId].label = `Thumbnailing reel ${i + 1}/${list.length}: ${r.name || r.id}`;
      try { await generateReelThumbnail(supabase, jobId, r.id, r.storage_path); done++; }
      catch (e) { failed++; failures.push(`${r.name || r.id}: ${e.message}`); console.warn(`[${jobId}] reel thumb failed for ${r.id}: ${e.message}`); }
      if (!jobs[jobId]) return;
    }
    jobs[jobId].status = failed === 0 ? 'done' : 'partial';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = `Thumbnailed ${done}/${list.length}${failed ? ` (${failed} failed)` : ''}`;
    jobs[jobId].error = failures.length ? failures.join(' | ') : null;
    console.log(`[${jobId}] reel-thumbnails-backfill done: ${done} ok, ${failed} failed`);
  } catch (e) {
    if (jobs[jobId]) { jobs[jobId].status = 'failed'; jobs[jobId].error = e.message; }
    console.error(`[${jobId}] reel-thumbnails-backfill failed:`, e.message);
  }
}

async function processOptimize(jobId, key) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const finish = (label) => {
    if (jobs[jobId]) {
      jobs[jobId].status = 'done'; jobs[jobId].progress = 100;
      jobs[jobId].stage = 'done'; jobs[jobId].label = label;
    }
    console.log(`[${jobId}] ${label} (${key})`);
  };

  // GUARD A (authoritative): /optimize-all calls this function DIRECTLY, bypassing
  // the endpoint check, so the claim has to live here to cover both paths.
  const owner = activeOptimizeKeys.get(key);
  if (owner && owner !== jobId && jobs[owner]) {
    finish(`Skipped — already optimizing under job ${owner}`);
    return;
  }
  activeOptimizeKeys.set(key, jobId);

  // GUARD B: don't burn a download + transcode on a key that is already done.
  // Cheap (one ~50ms read) and it runs BEFORE any bytes move. A read error is
  // NOT fatal — a transient blip must not block a legitimate optimize.
  try {
    const { data: rows, error: readErr } = await supabase
      .from('videos').select('id, original_url').eq('url', key).limit(1);
    if (readErr) {
      console.warn(`[${jobId}] pre-check read failed (continuing): ${readErr.message}`);
    } else if (!rows || rows.length === 0) {
      activeOptimizeKeys.delete(key);
      finish('Skipped — no videos row points at this key (already repointed?)');
      return;
    } else if (rows[0].original_url) {
      activeOptimizeKeys.delete(key);
      finish('Skipped — already optimized (original_url is set)');
      return;
    }
  } catch (e) {
    console.warn(`[${jobId}] pre-check threw (continuing): ${e?.message || e}`);
  }

  const tmpDir = `/tmp/opt_${jobId}`;
  const srcPath = `${tmpDir}/src.mp4`;
  const outPath = `${tmpDir}/out.mp4`;
  console.log(`[${jobId}] Optimize requested for ${key}`);

  try {
    // mkdir lives INSIDE the try so that a failure here (disk full, permissions)
    // still reaches the finally that releases the in-flight key. Outside it, the
    // key would stay claimed until the next restart and block every retry.
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1) Download the master (videos.url) to disk (streamed — memory-safe).
    jobs[jobId].stage = 'downloading';
    jobs[jobId].label = 'Downloading source...';
    jobs[jobId].progress = 5;
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    console.log(`[${jobId}] Downloaded ${(fs.statSync(srcPath).size / 1024 / 1024).toFixed(0)} MB`);

    // 2) Transcode → 720p H.264, 8-bit yuv420p (universally decodable), faststart.
    //    -map 0:v:0 -map 0:a:0? keeps the FIRST video + FIRST audio track and
    //    drops timed-metadata tracks. It is 0:a:0? and NOT 0:a? because the
    //    latter maps EVERY audio stream: a file carrying a second track with no
    //    decoder ("Decoder (codec none) not found for input stream #0:2") failed
    //    the whole transcode. Real re-encode (slow, CPU-bound) — the price of
    //    "plays anywhere".
    jobs[jobId].stage = 'transcoding';
    jobs[jobId].label = 'Transcoding to 720p H.264 (this takes a while)...';
    jobs[jobId].progress = 20;
    await execAsync(
      `ffmpeg -i ${srcPath} -map 0:v:0 -map 0:a:0? ` +
      // The second scale rounds DOWN to even dimensions. Fitting a PORTRAIT frame
      // inside 1280x720 yields an odd width (a 9:16 phone video → 405x720), and
      // libx264 with yuv420p rejects odd dimensions ("width not divisible by 2")
      // — so every vertically-shot video failed to optimize. trunc() is used
      // instead of force_divisible_by=2 because that needs ffmpeg >= 4.4; this
      // form works everywhere. No-op when the dimensions are already even, so
      // nothing that optimizes today changes. NOT padded (unlike /export and
      // /concat-game): padding would bake black bars into a vertical video.
      `-vf "scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p" ` +
      `-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart ${outPath} -y 2>&1`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const outSize = fs.statSync(outPath).size;
    console.log(`[${jobId}] Transcoded → ${(outSize / 1024 / 1024).toFixed(0)} MB`);
    try { fs.unlinkSync(srcPath); } catch (e) {}

    // 3) Upload the small copy to a NEW key (resumable/TUS, memory-safe).
    jobs[jobId].stage = 'uploading';
    jobs[jobId].label = 'Uploading streaming copy...';
    jobs[jobId].progress = 70;
    const newKey = `${key.replace(/\.mp4$/i, '')}-720${Date.now()}.mp4`;
    await resumableUpload(outPath, newKey, outSize, (sent, total) => {
      jobs[jobId].progress = 70 + Math.round((sent / total) * 27); // 70..97
    });

    // 4) Keep the master in original_url, point playback (url) at the small copy.
    //    Only videos.url is used for playback (no app change); original_url holds
    //    the master for full-quality download/export. The master file is NOT
    //    deleted.
    jobs[jobId].stage = 'saving';
    jobs[jobId].label = 'Switching playback to the streaming copy...';
    jobs[jobId].progress = 98;
    const { data: updated, error: dbErr } = await supabase
      .from('videos')
      .update({ original_url: key, url: newKey, upload_bytes: outSize })
      .eq('url', key)
      .select('id');
    if (dbErr) throw new Error(`DB repoint failed: ${dbErr.message}`);
    if (!updated || updated.length === 0) throw new Error(`No videos row found with url=${key}`);

    // 5) BEST-EFFORT poster thumbnail from the 720p copy. The `thumbnail` filter
    //    picks a representative frame (skips black/blur); -ss 1 skips the black
    //    camera-start. Wrapped so a failure here NEVER fails the optimize — the
    //    video is already repointed/done; a missing thumbnail just falls back to
    //    the card placeholder. Keyed by video id so sign-media can authorize it
    //    via the parent video (thumbnails/<id>.jpg).
    try {
      const videoId = updated[0].id;
      const thumbPath = `${tmpDir}/thumb.jpg`;
      await execAsync(
        `ffmpeg -ss 1 -i ${outPath} -vf "thumbnail=100,scale=640:-2" -frames:v 1 -q:v 3 ${thumbPath} -y 2>&1`,
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const thumbKey = `thumbnails/${videoId}.jpg`;
      const buf = fs.readFileSync(thumbPath);
      const { error: upErr } = await supabase.storage.from('Videos').upload(thumbKey, buf, { contentType: 'image/jpeg', upsert: true });
      if (upErr) throw upErr;
      await supabase.from('videos').update({ thumbnail_path: thumbKey }).eq('id', videoId);
      console.log(`[${jobId}] Thumbnail set: ${thumbKey}`);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail step skipped (non-fatal): ${e.message}`);
    }

    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = 'Optimized!';
    console.log(`[${jobId}] Optimize complete: play ${newKey}, master kept at ${key} (${updated.length} row(s))`);
  } catch (error) {
    // CRASH GUARD: jobs[jobId] can be GONE here (TTL cleanup evicted it mid-run).
    // Dereferencing it inside the catch threw a TypeError out of an un-awaited,
    // un-caught call → Node 18 kills the process → Railway restarts → every OTHER
    // in-flight job dies too. Read the stage defensively. Same fix in the other
    // three long workers; the batch functions already guarded this way.
    const stage = jobs[jobId] ? jobs[jobId].stage : '(job record evicted)';
    const detail = withCmdOutput(error);
    console.error(`[${jobId}] Optimize failed at "${stage}":`, detail);
    if (jobs[jobId]) {
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `${stage || 'processing'}: ${detail}`;
    }
  } finally {
    if (activeOptimizeKeys.get(key) === jobId) activeOptimizeKeys.delete(key);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function processFaststart(jobId, key) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tmpDir = `/tmp/fs_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcPath = `${tmpDir}/src.mp4`;
  const outPath = `${tmpDir}/out.mp4`;
  console.log(`[${jobId}] Faststart requested for ${key}`);

  try {
    // 1) Download the raw video to disk (streamed — memory-safe).
    jobs[jobId].stage = 'downloading';
    jobs[jobId].label = 'Downloading source...';
    jobs[jobId].progress = 5;
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    const inSize = fs.statSync(srcPath).size;
    console.log(`[${jobId}] Downloaded ${(inSize / 1024 / 1024).toFixed(0)} MB`);

    // 2) Lossless remux → moov atom to the front. -c copy = no re-encode, so
    //    it's fast (disk-bound) and pixel-identical; only the layout changes.
    jobs[jobId].stage = 'remuxing';
    jobs[jobId].label = 'Web-optimizing (faststart)...';
    jobs[jobId].progress = 45;
    await execAsync(
      `ffmpeg -i ${srcPath} -c copy -movflags +faststart -map 0 ${outPath} -y 2>&1`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const outSize = fs.statSync(outPath).size;
    console.log(`[${jobId}] Remuxed → ${(outSize / 1024 / 1024).toFixed(0)} MB`);

    // Free the source before the upload so peak /tmp usage is ~1 file, not 2.
    try { fs.unlinkSync(srcPath); } catch (e) {}

    // 3) Upload the faststarted file to a NEW key via Supabase's RESUMABLE (TUS)
    //    endpoint. A fresh key avoids the overwrite conflict (TUS PATCH 409 "the
    //    resource already exists" — upsert isn't honored the way the app never
    //    needs, since it always writes new timestamped keys) AND is safe: the
    //    original is never touched until the new object is up and the row is
    //    switched over. (A single multi-GB POST gets reset — 'write EPROTO' — so
    //    TUS chunks it, ~15MB in memory at a time, not the whole 4.75GB.)
    jobs[jobId].stage = 'uploading';
    jobs[jobId].label = 'Uploading web-optimized video...';
    jobs[jobId].progress = 70;
    const newKey = `${key.replace(/\.mp4$/i, '')}-fs${Date.now()}.mp4`;
    await resumableUpload(outPath, newKey, outSize, (sent, total) => {
      jobs[jobId].progress = 70 + Math.round((sent / total) * 27); // 70..97
    });

    // 4) Repoint the video's DB row to the faststarted object (service role
    //    bypasses RLS). Nothing else references the storage key — clips join on
    //    video_id, shares on content_id — so only videos.url needs switching.
    jobs[jobId].stage = 'saving';
    jobs[jobId].label = 'Switching to web-optimized version...';
    jobs[jobId].progress = 98;
    const { data: updated, error: dbErr } = await supabase
      .from('videos').update({ url: newKey, upload_bytes: outSize }).eq('url', key).select('id');
    if (dbErr) throw new Error(`DB repoint failed: ${dbErr.message}`);
    if (!updated || updated.length === 0) throw new Error(`No videos row found with url=${key}`);

    // 5) Delete the old (non-faststart) object — safe now that the row points at
    //    the new one. Non-fatal if it fails (just leaves an orphan to clean later).
    try {
      await supabase.storage.from('Videos').remove([key]);
    } catch (e) {
      console.warn(`[${jobId}] old-object cleanup failed (non-fatal):`, e.message);
    }

    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = 'Web-optimized!';
    console.log(`[${jobId}] Faststart complete: ${key} -> ${newKey} (${(outSize / 1024 / 1024).toFixed(0)} MB, ${updated.length} row(s) repointed)`);
  } catch (error) {
    const msg = error?.response
      ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data)}`
      : error.message;
    const stage = jobs[jobId] ? jobs[jobId].stage : '(job record evicted)';
    console.error(`[${jobId}] Faststart failed at "${stage}":`, msg);
    if (jobs[jobId]) {
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `${stage || 'processing'}: ${msg}`;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function processExport(jobId, clips, outputFileName) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`[${jobId}] Starting export with ${clips.length} clips`);

  try {
    // PHASE 1: Download each unique source video ONCE (was N times!).
    // Clips now arrive as bare storage PATHS; mint a fresh signed URL per
    // unique path right before downloading. sourceMap stays keyed by PATH
    // (signed URLs differ per mint, so they can't be dedupe keys).
    const uniquePaths = [...new Set(clips.map(c => c.url))];
    console.log(`[${jobId}] Downloading ${uniquePaths.length} unique source video(s) for ${clips.length} clips`);
    jobs[jobId].stage = 'downloading';

    const sourceMap = {};
    for (let i = 0; i < uniquePaths.length; i++) {
      const path = uniquePaths[i];
      const sourcePath = `${tmpDir}/source_${i}.mp4`;
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].phaseTotal = uniquePaths.length;
      jobs[jobId].label = `Downloading source ${i + 1} of ${uniquePaths.length}...`;
      console.log(`[${jobId}] Downloading source ${i + 1}/${uniquePaths.length}`);
      const signedUrl = await signObjectUrl(supabase, path, SOURCE_URL_TTL_SECONDS);
      await downloadFile(signedUrl, sourcePath);
      sourceMap[path] = sourcePath;
      const stats = fs.statSync(sourcePath);
      console.log(`[${jobId}] Source ${i + 1} downloaded: ${(stats.size / 1024 / 1024).toFixed(0)} MB`);
      jobs[jobId].progress = Math.round(((i + 1) / uniquePaths.length) * 50);
    }

    // PHASE 2: Trim each clip from its (already downloaded) source
    jobs[jobId].stage = 'trimming';
    const trimmedFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const sourcePath = sourceMap[clip.url];
      const trimmedPath = `${tmpDir}/trimmed_${i}.mp4`;
      const startTime = clip.start_time;
      const duration = clip.end_time - clip.start_time;
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].phaseTotal = clips.length;
      jobs[jobId].label = `Trimming clip ${i + 1} of ${clips.length}...`;
      console.log(`[${jobId}] Trimming clip ${i + 1}/${clips.length}: ${duration.toFixed(1)}s starting at ${startTime.toFixed(1)}s`);

      // execAsync (not execSync) so the Node event loop keeps servicing /job/:id
      // status polls while ffmpeg runs in its child process. maxBuffer raised to
      // 10MB so ffmpeg's verbose stderr (redirected via 2>&1) doesn't overflow.
      //
      // QUALITY: the reel is a SECOND encode of already-720p-CRF-23 source clips, so
      // these per-clip settings decide whether the reel looks as good as the source.
      // preset medium + crf 18 = a visually-lossless second pass relative to the
      // CRF-23 source, so the reel MATCHES the source instead of looking downgraded.
      // Cost: modestly larger reel + a bit more render time; playback stays fast
      // (short 720p clip, faststart preserved). Was: preset fast + crf 23 (visibly soft).
      await execAsync(`ffmpeg -ss ${startTime} -i ${sourcePath} -t ${duration} -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset medium -crf 18 -c:a aac -ar 48000 -ac 2 -fps_mode cfr -async 1 -movflags +faststart ${trimmedPath} -y 2>&1`, { maxBuffer: 10 * 1024 * 1024 });
      trimmedFiles.push(trimmedPath);
      jobs[jobId].progress = 50 + Math.round(((i + 1) / clips.length) * 25);
    }

    // PHASE 3: Free up source files before concat/upload
    console.log(`[${jobId}] Freeing source files`);
    for (const sourcePath of Object.values(sourceMap)) {
      try { fs.unlinkSync(sourcePath); } catch (e) {}
    }

    // PHASE 4: Concatenate trimmed clips
    jobs[jobId].stage = 'concatenating';
    jobs[jobId].progress = 80;
    jobs[jobId].phaseItem = null;
    jobs[jobId].phaseTotal = null;
    jobs[jobId].label = 'Joining clips...';
    const concatFile = `${tmpDir}/concat.txt`;
    const concatContent = trimmedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    const outputPath = `${tmpDir}/output.mp4`;
    console.log(`[${jobId}] Concatenating ${trimmedFiles.length} clips`);
    // +faststart moves the moov index atom to the FRONT so browsers can stream the
    // reel on web (the per-clip faststart is lost by the -c copy concat otherwise).
    // Still -c copy (no re-encode) — negligible cost, no quality change.
    await execAsync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy -movflags +faststart ${outputPath} -y 2>&1`, { maxBuffer: 10 * 1024 * 1024 });

    // PHASE 5: Upload final video to Supabase
    jobs[jobId].stage = 'uploading';
    jobs[jobId].progress = 90;
    jobs[jobId].label = 'Uploading highlight reel...';
    const fileBuffer = fs.readFileSync(outputPath);
    const fileName = `exports/${Date.now()}.mp4`;
    console.log(`[${jobId}] Uploading ${(fileBuffer.length / 1024 / 1024).toFixed(0)} MB highlight reel to Supabase`);
    const { error: uploadError } = await supabase.storage
      .from('Videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4' });

    if (uploadError) {
      console.error(`[${jobId}] Upload error:`, uploadError);
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `Upload failed: ${uploadError.message}`;
      return;
    }

    // Deliver the rendered reel via a signed URL — the bucket is private now.
    const { data: signedData, error: signError } = await supabase.storage
      .from('Videos')
      .createSignedUrl(fileName, OUTPUT_URL_TTL_SECONDS);
    if (signError || !signedData) {
      console.error(`[${jobId}] Output sign error:`, signError);
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `Could not sign output: ${signError?.message ?? 'no data'}`;
      return;
    }
    jobs[jobId].status = 'done';
    jobs[jobId].url = signedData.signedUrl;
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = 'Complete!';
    console.log(`[${jobId}] Export complete: ${signedData.signedUrl}`);

  } catch (error) {
    const stage = jobs[jobId] ? jobs[jobId].stage : '(job record evicted)';
    console.error(`[${jobId}] Export failed at stage "${stage}":`, error.message);
    if (jobs[jobId]) {
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `${stage || 'processing'}: ${error.message}`;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Stitch a game's videos into one downloadable MP4 (see /concat-game above).
async function processConcatGame(jobId, keys, outputFileName) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tmpDir = `/tmp/cg_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`[${jobId}] Concat-game: ${keys.length} video(s)`);

  try {
    // PHASE 1+2 (fused per item): download each source, normalize to a uniform
    // 720p H.264 profile, then DELETE the raw source before the next download so
    // peak disk stays ~1 raw + the small 720p copies.
    const normFiles = [];
    for (let i = 0; i < keys.length; i++) {
      const srcPath = `${tmpDir}/src_${i}.mp4`;
      const normPath = `${tmpDir}/norm_${i}.mp4`;

      jobs[jobId].stage = 'downloading';
      jobs[jobId].phaseItem = i + 1;
      jobs[jobId].phaseTotal = keys.length;
      jobs[jobId].label = `Preparing video ${i + 1} of ${keys.length}...`;
      console.log(`[${jobId}] Downloading source ${i + 1}/${keys.length}`);
      const signedUrl = await signObjectUrl(supabase, keys[i], SOURCE_URL_TTL_SECONDS);
      await downloadFile(signedUrl, srcPath);

      jobs[jobId].stage = 'normalizing';
      // Identical profile across every input = a glitch-free -c copy concat.
      // 720p H.264 yuv420p (SDR-safe), 30fps CFR, resampled audio, faststart —
      // same family as /optimize, so it matches the app's own optimized copies.
      // preset veryfast/crf 23 = good quality at a reasonable speed for a
      // full-length re-encode.
      await execAsync(
        `ffmpeg -i ${srcPath} -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -fps_mode cfr -async 1 -movflags +faststart ${normPath} -y 2>&1`,
        { maxBuffer: 10 * 1024 * 1024 },
      );
      try { fs.unlinkSync(srcPath); } catch (e) {}
      normFiles.push(normPath);
      jobs[jobId].progress = Math.round(((i + 1) / keys.length) * 75);
    }

    // PHASE 3: concat — inputs are now one identical profile, so -c copy is safe.
    jobs[jobId].stage = 'concatenating';
    jobs[jobId].phaseItem = null;
    jobs[jobId].phaseTotal = null;
    jobs[jobId].label = 'Joining videos...';
    jobs[jobId].progress = 80;
    const concatFile = `${tmpDir}/concat.txt`;
    fs.writeFileSync(concatFile, normFiles.map(f => `file '${f}'`).join('\n'));
    const outputPath = `${tmpDir}/output.mp4`;
    console.log(`[${jobId}] Concatenating ${normFiles.length} normalized video(s)`);
    await execAsync(
      `ffmpeg -f concat -safe 0 -i ${concatFile} -c copy -movflags +faststart ${outputPath} -y 2>&1`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
    for (const f of normFiles) { try { fs.unlinkSync(f); } catch (e) {} }

    // PHASE 4: upload the stitched file (resumable = memory-safe for multi-GB).
    jobs[jobId].stage = 'uploading';
    jobs[jobId].label = 'Uploading stitched game...';
    jobs[jobId].progress = 85;
    const outSize = fs.statSync(outputPath).size;
    const fileName = `game-downloads/${Date.now()}.mp4`;
    console.log(`[${jobId}] Uploading stitched game (${(outSize / 1024 / 1024).toFixed(0)} MB)`);
    await resumableUpload(outputPath, fileName, outSize, (sent, total) => {
      jobs[jobId].progress = 85 + Math.round((sent / total) * 12); // 85..97
    });

    // PHASE 5: hand back a signed URL (private bucket) — the client downloads it
    // directly (sign-media can't authorize it; it's not a videos row).
    const { data: signedData, error: signError } = await supabase.storage
      .from('Videos').createSignedUrl(fileName, OUTPUT_URL_TTL_SECONDS);
    if (signError || !signedData) {
      throw new Error(`Could not sign output: ${signError?.message ?? 'no data'}`);
    }

    jobs[jobId].status = 'done';
    jobs[jobId].url = signedData.signedUrl;
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = 'Complete!';
    console.log(`[${jobId}] Concat-game complete: ${(outSize / 1024 / 1024).toFixed(0)} MB`);
  } catch (error) {
    const stage = jobs[jobId] ? jobs[jobId].stage : '(job record evicted)';
    console.error(`[${jobId}] Concat-game failed at "${stage}":`, error.message);
    if (jobs[jobId]) {
      jobs[jobId].status = 'failed';
      jobs[jobId].error = `${stage || 'processing'}: ${error.message}`;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Mint a short-lived signed URL for a private-bucket object key, using the
// service-role client. Throws on failure so the caller's try/catch marks the
// job failed (consistent with how source-download errors propagate).
async function signObjectUrl(supabase, key, expiresInSeconds) {
  const { data, error } = await supabase.storage
    .from('Videos')
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data) {
    throw new Error(`Failed to sign '${key}': ${error?.message ?? 'no data'}`);
  }
  return data.signedUrl;
}

// Upload a local file to the Videos bucket via Supabase's RESUMABLE (TUS)
// endpoint, overwriting objectKey. Supabase's standard upload rejects/reset a
// multi-GB single request; TUS chunks it (same protocol the app uses to upload
// games). Reads ~15MB at a time from disk — never the whole file into memory.
// Auth is the service-role key. onProgress(sentBytes, totalBytes) is optional.
async function resumableUpload(filePath, objectKey, size, onProgress) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const authHeaders = {
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  };

  // Create the upload session → server returns the chunk-PATCH URL in Location.
  const createResp = await fetch(`${SUPABASE_URL}/storage/v1/upload/resumable`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'x-upsert': 'true',
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': [
        `bucketName ${b64('Videos')}`,
        `objectName ${b64(objectKey)}`,
        `contentType ${b64('video/mp4')}`,
        `cacheControl ${b64('3600')}`,
      ].join(','),
    },
  });
  if (!createResp.ok) {
    throw new Error(`TUS create ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`);
  }
  let uploadUrl = createResp.headers.get('location');
  if (!uploadUrl) throw new Error('TUS create returned no Location header');
  if (!/^https?:\/\//.test(uploadUrl)) {
    uploadUrl = `${SUPABASE_URL}${uploadUrl.startsWith('/') ? '' : '/'}${uploadUrl}`;
  }

  // PATCH 15MB chunks, adopting the server's Upload-Offset each time.
  const CHUNK = 15 * 1024 * 1024; // 15MB — proven chunk size for Supabase (matches the app)
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let offset = 0;
    while (offset < size) {
      const want = Math.min(CHUNK, size - offset);
      const read = fs.readSync(fd, buf, 0, want, offset);
      const resp = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: {
          ...authHeaders,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: buf.subarray(0, read),
      });
      if (!resp.ok && resp.status !== 204) {
        throw new Error(`TUS PATCH ${resp.status} at ${offset}: ${(await resp.text()).slice(0, 200)}`);
      }
      const raw = resp.headers.get('upload-offset');
      const srv = raw != null ? parseInt(raw, 10) : NaN;
      offset = Number.isFinite(srv) ? srv : offset + read;
      if (typeof onProgress === 'function') onProgress(offset, size);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, response => {
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${response.statusCode} downloading source video`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', err => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
    req.on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
    req.setTimeout(30 * 60 * 1000, () => {
      req.destroy(new Error('Download timeout (30 min)'));
    });
  });
}

// Drop FINISHED jobs after an hour. Still-running jobs get a much longer hard
// cap: the old rule evicted purely on age, so a job that outran the TTL (a long
// concat/export, or a transcode slowed by CPU contention) had its record deleted
// mid-flight — which made /job/:id 404 for a job that was still working, and made
// the next jobs[jobId] write throw. The hard cap still bounds memory if a job
// somehow never reaches a terminal state. In-memory only — a Railway restart
// wipes the Map regardless. Wrapped in try/catch so a bad iteration can't kill
// the interval timer.
const JOB_TTL_MS = 60 * 60 * 1000;                 // terminal jobs
const RUNNING_JOB_TTL_MS = 6 * 60 * 60 * 1000;     // still-running jobs (hard cap)
const TERMINAL_JOB_STATUSES = new Set(['done', 'failed', 'partial']);
const JOB_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  try {
    const now = Date.now();
    for (const id of Object.keys(jobs)) {
      const job = jobs[id];
      const running = !TERMINAL_JOB_STATUSES.has(job.status);
      const ttl = running ? RUNNING_JOB_TTL_MS : JOB_TTL_MS;
      if (now - (job.createdAt || 0) > ttl) {
        delete jobs[id];
        console.log(`[cleanup] dropped ${running ? 'STUCK running' : 'finished'} job ${id}`);
      }
    }
  } catch (e) {
    console.error('[cleanup] interval error:', e.message);
  }
}, JOB_CLEANUP_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORARY — Part 2 benchmark. DELETE THIS BLOCK once the numbers are in.
// Measurement only: it never touches the videos table, never repoints a url,
// never deletes a master, and does not share code paths with /optimize.
// Profiles are HARDCODED — no caller-supplied ffmpeg arguments, ever, because
// this runs shell commands on the production container.
// ═══════════════════════════════════════════════════════════════════════════
const BENCHMARK_SECRET = '-_QX-3RyKWt2cDTi8kMNFxzgPqlzRouJ5UkO29iXTZc';
let benchmarkBusy = false;   // one at a time, so the two runs never share CPU

const BENCHMARK_PROFILES = {
  // Exactly what production runs today (server commits cbea544 + ace2514).
  current: {
    label: 'current (veryfast / crf 23 / source fps)',
    forceFps30: false,
    args: '-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k',
  },
  // Playback/tagging proxy: watchable and seekable, not archival.
  fast: {
    label: 'fast proxy (ultrafast / crf 26 / 30fps cap / 96k audio)',
    forceFps30: true,
    args: '-c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 96k',
  },
};

app.post('/benchmark', async (req, res) => {
  try {
    if ((req.headers['x-benchmark-secret'] || '') !== BENCHMARK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { key, profile } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'No storage key provided' });
    if (!BENCHMARK_PROFILES[profile]) return res.status(400).json({ error: 'profile must be current|fast' });
    if (benchmarkBusy) return res.status(409).json({ error: 'a benchmark is already running' });

    const jobId = 'bench' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'starting', phaseItem: null, phaseTotal: null,
      label: `Benchmark: ${BENCHMARK_PROFILES[profile].label}`, createdAt: Date.now(),
    };
    res.json({ jobId });
    runBenchmark(jobId, key, profile).catch((e) => console.error(`[${jobId}] runBenchmark rejected:`, e?.message || e));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runBenchmark(jobId, key, profile) {
  benchmarkBusy = true;
  const prof = BENCHMARK_PROFILES[profile];
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tmpDir = `/tmp/bench_${jobId}`;
  const srcPath = `${tmpDir}/src.mp4`;
  const outPath = `${tmpDir}/out.mp4`;
  const outKey = `benchmark-temp/${jobId}-${profile}.mp4`;
  const t = {};
  const mark = (name) => { t[name] = Date.now(); };

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    mark('started');

    // ── 1. DOWNLOAD ────────────────────────────────────────────────────────
    jobs[jobId].stage = 'downloading'; jobs[jobId].progress = 5;
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    mark('downloadStart');
    await downloadFile(signedUrl, srcPath);
    mark('downloadEnd');
    const srcBytes = fs.statSync(srcPath).size;

    // ── 2. PROBE the source (specs for the report) ─────────────────────────
    let probe = null;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate,nb_frames -show_entries format=duration,size,bit_rate -of json ${srcPath}`,
        { maxBuffer: 4 * 1024 * 1024 });
      probe = JSON.parse(stdout);
    } catch (e) { probe = { error: e.message }; }

    const st = (probe && probe.streams && probe.streams[0]) || {};
    const fmt = (probe && probe.format) || {};
    const rateParts = String(st.r_frame_rate || '0/1').split('/');
    const srcFps = Number(rateParts[1]) ? Number(rateParts[0]) / Number(rateParts[1]) : 0;
    const srcDuration = Number(fmt.duration || 0);

    // ── 3. TRANSCODE ───────────────────────────────────────────────────────
    // Same protections production has: portrait/odd-width guard, first audio
    // track only, faststart. The 30fps cap is applied ONLY when the source is
    // above 30, so a 30fps source keeps its own timing untouched.
    const fpsFilter = (prof.forceFps30 && srcFps > 30.5) ? 'fps=30,' : '';
    const vf = `${fpsFilter}scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
    const cmd = `ffmpeg -i ${srcPath} -map 0:v:0 -map 0:a:0? -vf "${vf}" ${prof.args} -movflags +faststart ${outPath} -y 2>&1`;

    jobs[jobId].stage = 'transcoding'; jobs[jobId].progress = 20;
    mark('transcodeStart');
    const { stdout: ffout } = await execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 });
    mark('transcodeEnd');

    // ffmpeg prints a trailing "speed=N.NNx" — realtime multiplier.
    const speedMatches = String(ffout || '').match(/speed=\s*([0-9.]+)x/g) || [];
    const lastSpeed = speedMatches.length ? speedMatches[speedMatches.length - 1] : null;
    const outBytes = fs.statSync(outPath).size;

    // Probe the OUTPUT too — duration drift and fps accuracy matter for tagging.
    let outProbe = null;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate,nb_frames -show_entries format=duration -of json ${outPath}`,
        { maxBuffer: 4 * 1024 * 1024 });
      outProbe = JSON.parse(stdout);
    } catch (e) { outProbe = { error: e.message }; }

    try { fs.unlinkSync(srcPath); } catch (e) {}

    // ── 4. UPLOAD to a clearly throwaway key ───────────────────────────────
    jobs[jobId].stage = 'uploading'; jobs[jobId].progress = 70;
    mark('uploadStart');
    await resumableUpload(outPath, outKey, outBytes, () => {});
    mark('uploadEnd');

    const secs = (a, b) => Number(((t[b] - t[a]) / 1000).toFixed(1));
    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = `Benchmark complete: ${prof.label}`;
    jobs[jobId].benchmark = {
      profile, profileLabel: prof.label, key, outKey, command: cmd,
      source: {
        bytes: srcBytes,
        durationSec: srcDuration,
        resolution: (st.width && st.height) ? `${st.width}x${st.height}` : null,
        fps: srcFps ? Number(srcFps.toFixed(3)) : null,
        codec: st.codec_name || null,
        bitRate: fmt.bit_rate || null,
      },
      output: {
        bytes: outBytes,
        durationSec: outProbe && outProbe.format ? Number(outProbe.format.duration) : null,
        resolution: outProbe && outProbe.streams && outProbe.streams[0]
          ? `${outProbe.streams[0].width}x${outProbe.streams[0].height}` : null,
        fps: outProbe && outProbe.streams && outProbe.streams[0] ? outProbe.streams[0].r_frame_rate : null,
        codec: outProbe && outProbe.streams && outProbe.streams[0] ? outProbe.streams[0].codec_name : null,
      },
      timingsSec: {
        download: secs('downloadStart', 'downloadEnd'),
        transcode: secs('transcodeStart', 'transcodeEnd'),
        upload: secs('uploadStart', 'uploadEnd'),
        total: secs('started', 'uploadEnd'),
      },
      wallClock: {
        started: new Date(t.started).toISOString(),
        downloadEnd: new Date(t.downloadEnd).toISOString(),
        transcodeEnd: new Date(t.transcodeEnd).toISOString(),
        uploadEnd: new Date(t.uploadEnd).toISOString(),
      },
      ffmpegSpeed: lastSpeed,
      transcodeRealtimeX: srcDuration && t.transcodeEnd
        ? Number((srcDuration / ((t.transcodeEnd - t.transcodeStart) / 1000)).toFixed(2)) : null,
      host: { cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || null,
              totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576) },
    };
    console.log(`[${jobId}] benchmark done:`, JSON.stringify(jobs[jobId].benchmark.timingsSec));
  } catch (error) {
    const stage = jobs[jobId] ? jobs[jobId].stage : '(evicted)';
    const detail = withCmdOutput(error);
    console.error(`[${jobId}] benchmark failed at "${stage}":`, detail);
    if (jobs[jobId]) { jobs[jobId].status = 'failed'; jobs[jobId].error = `${stage}: ${detail}`; }
  } finally {
    benchmarkBusy = false;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Remove a benchmark output once measured. Refuses anything outside the
// benchmark-temp/ prefix so it can never be aimed at real media.
app.post('/benchmark-cleanup', async (req, res) => {
  try {
    if ((req.headers['x-benchmark-secret'] || '') !== BENCHMARK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { keys } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: 'keys[] required' });
    if (!keys.every(k => typeof k === 'string' && k.startsWith('benchmark-temp/'))) {
      return res.status(400).json({ error: 'refusing: keys must start with benchmark-temp/' });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.storage.from('Videos').remove(keys);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ removed: (data || []).map(d => d.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ═══════════════════ END TEMPORARY BENCHMARK BLOCK ═════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IamSports server running on port ${PORT}`);
});