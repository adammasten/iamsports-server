const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'IamSports server running!' });
});

app.post('/export', async (req, res) => {
  const { clips, outputFileName } = req.body;

  if (!clips || clips.length === 0) {
    return res.status(400).json({ error: 'No clips provided' });
  }

  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Download each video segment
    const downloadedFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const filePath = `${tmpDir}/clip_${i}.mp4`;
      const trimmedPath = `${tmpDir}/trimmed_${i}.mp4`;

      // Download video
      await downloadFile(clip.url, filePath);

      // Trim clip using FFmpeg
      execSync(`ffmpeg -i ${filePath} -ss ${clip.start_time} -to ${clip.end_time} -c copy ${trimmedPath}`);
      downloadedFiles.push(trimmedPath);
    }

    // Create concat file
    const concatFile = `${tmpDir}/concat.txt`;
    const concatContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    // Stitch clips together
    const outputPath = `${tmpDir}/output.mp4`;
    execSync(`ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath}`);

    // Send file back
    res.download(outputPath, outputFileName || 'highlight.mp4', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: error.message });
  }
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
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