const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wscfpkaltajnrhiusoze.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzY2Zwa2FsdGFqbnJoaXVzb3plIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyOTE3OSwiZXhwIjoyMDkzMDA1MTc5fQ.EGAIIqEwwWXs3_hENzrExZum56AqFMbWCj-czXaR1GE';
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const jobs = {};

app.get('/', (req, res) => {
  res.json({ status: 'IamSports server running!', supabaseConnected: !!SUPABASE_URL });
});

app.post('/export', async (req, res) => {
  try {
    const { clips, outputFileName } = req.body;
    if (!clips || clips.length === 0) {
      return res.status(400).json({ error: 'No clips provided' });
    }
    const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    jobs[jobId] = { status: 'processing', url: null, error: null, progress: 0, stage: 'starting' };
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

async function processExport(jobId, clips, outputFileName) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`[${jobId}] Starting export with ${clips.length} clips`);

  try {
    // PHASE 1: Download each unique source video ONCE (was N times!)
    const uniqueUrls = [...new Set(clips.map(c => c.url))];
    console.log(`[${jobId}] Downloading ${uniqueUrls.length} unique source video(s) for ${clips.length} clips`);
    jobs[jobId].stage = 'downloading';

    const sourceMap = {};
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      const sourcePath = `${tmpDir}/source_${i}.mp4`;
      console.log(`[${jobId}] Downloading source ${i + 1}/${uniqueUrls.length}`);
      await downloadFile(url, sourcePath);
      sourceMap[url] = sourcePath;
      const stats = fs.statSync(sourcePath);
      console.log(`[${jobId}] Source ${i + 1} downloaded: ${(stats.size / 1024 / 1024).toFixed(0)} MB`);
      jobs[jobId].progress = Math.round(((i + 1) / uniqueUrls.length) * 50);
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
      console.log(`[${jobId}] Trimming clip ${i + 1}/${clips.length}: ${duration.toFixed(1)}s starting at ${startTime.toFixed(1)}s`);

      execSync(`ffmpeg -ss ${startTime} -i ${sourcePath} -t ${duration} -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 48000 -ac 2 -fps_mode cfr -async 1 -movflags +faststart ${trimmedPath} -y 2>&1`, { stdio: 'pipe' });
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
    const concatFile = `${tmpDir}/concat.txt`;
    const concatContent = trimmedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    const outputPath = `${tmpDir}/output.mp4`;
    console.log(`[${jobId}] Concatenating ${trimmedFiles.length} clips`);
    execSync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath} -y 2>&1`, { stdio: 'pipe' });

    // PHASE 5: Upload final video to Supabase
    jobs[jobId].stage = 'uploading';
    jobs[jobId].progress = 90;
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

    const { data: urlData } = supabase.storage.from('Videos').getPublicUrl(fileName);
    jobs[jobId].status = 'done';
    jobs[jobId].url = urlData.publicUrl;
    jobs[jobId].progress = 100;
    jobs[jobId].stage = 'done';
    console.log(`[${jobId}] Export complete: ${urlData.publicUrl}`);

  } catch (error) {
    console.error(`[${jobId}] Export failed at stage "${jobs[jobId].stage}":`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = `${jobs[jobId].stage || 'processing'}: ${error.message}`;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IamSports server running on port ${PORT}`);
});