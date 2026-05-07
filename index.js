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
const { clips, outputFileName } = req.body;
if (!clips || clips.length === 0) {
return res.status(400).json({ error: 'No clips provided' });
  }
const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36);
jobs[jobId] = { status: 'processing', url: null, error: null, progress: 0 };
res.json({ jobId });
processExport(jobId, clips, outputFileName);
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
try {
const downloadedFiles = [];
for (let i = 0; i < clips.length; i++) {
const clip = clips[i];
const filePath = `${tmpDir}/clip_${i}.mp4`;
const trimmedPath = `${tmpDir}/trimmed_${i}.mp4`;
      jobs[jobId].progress = Math.round((i / clips.length) * 70);
await downloadFile(clip.url, filePath);
execSync(`ffmpeg -i ${filePath} -ss ${clip.start_time} -to ${clip.end_time} -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 48000 -ac 2 -fps_mode cfr -async 1 -movflags +faststart ${trimmedPath} -y`);
      downloadedFiles.push(trimmedPath);
    }
    jobs[jobId].progress = 75;
const concatFile = `${tmpDir}/concat.txt`;
const concatContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
const outputPath = `${tmpDir}/output.mp4`;
execSync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath} -y`);
    jobs[jobId].progress = 90;
const fileBuffer = fs.readFileSync(outputPath);
const fileName = `exports/${Date.now()}.mp4`;
const { error: uploadError } = await supabase.storage
      .from('Videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4' });
if (uploadError) {
      jobs[jobId].status = 'failed';
      jobs[jobId].error = uploadError.message;
return;
    }
const { data: urlData } = supabase.storage.from('Videos').getPublicUrl(fileName);
    jobs[jobId].status = 'done';
    jobs[jobId].url = urlData.publicUrl;
    jobs[jobId].progress = 100;
  } catch (error) {
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
function downloadFile(url, dest) {
return new Promise((resolve, reject) => {
const file = fs.createWriteStream(dest);
const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, response => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(dest, () => {});
reject(err);
    });
  });
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IamSports server running on port ${PORT}`);
});