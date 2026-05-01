const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  res.json({ 
    status: 'IamSports server running!',
    hasUrl: !!supabaseUrl,
    hasKey: !!supabaseKey
  });
});

app.post('/export', async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing Supabase credentials' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { clips, outputFileName } = req.body;

  if (!clips || clips.length === 0) {
    return res.status(400).json({ error: 'No clips provided' });
  }

  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const downloadedFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const filePath = `${tmpDir}/clip_${i}.mp4`;
      const trimmedPath = `${tmpDir}/trimmed_${i}.mp4`;

      await downloadFile(clip.url, filePath);
      execSync(`ffmpeg -i ${filePath} -ss ${clip.start_time} -to ${clip.end_time} -c copy ${trimmedPath} -y`);
      downloadedFiles.push(trimmedPath);
    }

    const concatFile = `${tmpDir}/concat.txt`;
    const concatContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const outputPath = `${tmpDir}/output.mp4`;
    execSync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath} -y`);

    const fileBuffer = fs.readFileSync(outputPath);
    const fileName = `exports/${Date.now()}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('Videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4' });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    const { data: urlData } = supabase.storage.from('Videos').getPublicUrl(fileName);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.json({ url: urlData.publicUrl });

  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: error.message });
  }
});

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