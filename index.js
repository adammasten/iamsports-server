const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wscfpkaltajnrhiusoze.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const jobs = {};

// Signed-URL lifetimes (seconds). Source URLs only need to outlive a single
// download (downloadFile caps at 30 min); 1h gives margin. The output URL is
// handed to the client to save to the camera roll — 24h so an offline or
// delayed retry doesn't lose the export.
const SOURCE_URL_TTL_SECONDS = 3600;   // 1 hour
const OUTPUT_URL_TTL_SECONDS = 86400;  // 24 hours

app.get('/', (req, res) => {
  res.json({ status: 'IamSports server running!', supabaseConnected: !!SUPABASE_URL, faststart: 'resumable-v3', optimize: 'v1' });
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
    processExport(jobId, clips, outputFileName);
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
// (reels already stream because /export writes them with +faststart, line ~110).
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
    processFaststart(jobId, key);
  } catch (e) {
    console.error('Faststart endpoint error:', e);
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
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = {
      status: 'processing', url: null, error: null, progress: 0,
      stage: 'starting', phaseItem: null, phaseTotal: null,
      label: 'Queued...', createdAt: Date.now(),
    };
    res.json({ jobId });
    processOptimize(jobId, key);
  } catch (e) {
    console.error('Optimize endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function processOptimize(jobId, key) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tmpDir = `/tmp/opt_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcPath = `${tmpDir}/src.mp4`;
  const outPath = `${tmpDir}/out.mp4`;
  console.log(`[${jobId}] Optimize requested for ${key}`);

  try {
    // 1) Download the master (videos.url) to disk (streamed — memory-safe).
    jobs[jobId].stage = 'downloading';
    jobs[jobId].label = 'Downloading source...';
    jobs[jobId].progress = 5;
    const signedUrl = await signObjectUrl(supabase, key, SOURCE_URL_TTL_SECONDS);
    await downloadFile(signedUrl, srcPath);
    console.log(`[${jobId}] Downloaded ${(fs.statSync(srcPath).size / 1024 / 1024).toFixed(0)} MB`);

    // 2) Transcode → 720p H.264, 8-bit yuv420p (universally decodable), faststart.
    //    -map 0:v:0 -map 0:a? keeps first video + audio, drops timed-metadata
    //    tracks. Real re-encode (slow, CPU-bound) — the price of "plays anywhere".
    jobs[jobId].stage = 'transcoding';
    jobs[jobId].label = 'Transcoding to 720p H.264 (this takes a while)...';
    jobs[jobId].progress = 20;
    await execAsync(
      `ffmpeg -i ${srcPath} -map 0:v:0 -map 0:a? ` +
      `-vf "scale=1280:720:force_original_aspect_ratio=decrease,format=yuv420p" ` +
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

    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    jobs[jobId].label = 'Optimized!';
    console.log(`[${jobId}] Optimize complete: play ${newKey}, master kept at ${key} (${updated.length} row(s))`);
  } catch (error) {
    console.error(`[${jobId}] Optimize failed at "${jobs[jobId].stage}":`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = `${jobs[jobId].stage || 'processing'}: ${error.message}`;
  } finally {
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
    console.error(`[${jobId}] Faststart failed at "${jobs[jobId].stage}":`, msg);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = `${jobs[jobId].stage || 'processing'}: ${msg}`;
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
      await execAsync(`ffmpeg -ss ${startTime} -i ${sourcePath} -t ${duration} -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 48000 -ac 2 -fps_mode cfr -async 1 -movflags +faststart ${trimmedPath} -y 2>&1`, { maxBuffer: 10 * 1024 * 1024 });
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
    await execAsync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath} -y 2>&1`, { maxBuffer: 10 * 1024 * 1024 });

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
    console.error(`[${jobId}] Export failed at stage "${jobs[jobId].stage}":`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = `${jobs[jobId].stage || 'processing'}: ${error.message}`;
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

// Drop jobs older than 1 hour. In-memory only — Railway restart wipes the
// Map regardless. Wrapped in try/catch so a bad iteration can't kill the
// interval timer.
const JOB_TTL_MS = 60 * 60 * 1000;
const JOB_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  try {
    const now = Date.now();
    for (const id of Object.keys(jobs)) {
      if (now - (jobs[id].createdAt || 0) > JOB_TTL_MS) {
        delete jobs[id];
        console.log(`[cleanup] dropped stale job ${id}`);
      }
    }
  } catch (e) {
    console.error('[cleanup] interval error:', e.message);
  }
}, JOB_CLEANUP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IamSports server running on port ${PORT}`);
});