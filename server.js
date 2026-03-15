const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
app.use(cors());
app.use(express.json());

// Ensure directories exist
const streamsDir = path.resolve(config.streamsDir);
const recordingsDir = path.resolve(config.recordingsDir);
[streamsDir, recordingsDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Track active FFmpeg processes
const streamProcesses = {};   // { camId: childProcess }
const recordProcesses = {};   // { camId: { process, filename, startTime } }

// ============== FFmpeg Stream Management ==============

function startStream(camera) {
    if (streamProcesses[camera.id]) {
        console.log(`[STREAM] ${camera.name} already streaming`);
        return;
    }

    const camStreamDir = path.join(streamsDir, camera.id);
    if (!fs.existsSync(camStreamDir)) fs.mkdirSync(camStreamDir, { recursive: true });

    // Clean old segments
    fs.readdirSync(camStreamDir).forEach(f => {
        fs.unlinkSync(path.join(camStreamDir, f));
    });

    const args = [
        '-fflags', '+genpts+discardcorrupt',
        '-rtsp_transport', 'tcp',
        '-use_wallclock_as_timestamps', '1',
        '-i', camera.rtspUrl,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-r', '15',
        '-g', '30',
        '-an',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_allow_cache', '0',
        path.join(camStreamDir, 'stream.m3u8')
    ];

    console.log(`[STREAM] Starting stream for ${camera.name}: ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
            console.error(`[STREAM][${camera.name}] ${msg.trim()}`);
        }
    });

    proc.on('close', (code) => {
        console.log(`[STREAM] ${camera.name} stream ended with code ${code}`);
        delete streamProcesses[camera.id];

        // Auto-restart after 5 seconds if it crashed
        if (code !== 0 && code !== null) {
            console.log(`[STREAM] Will restart ${camera.name} in 5 seconds...`);
            setTimeout(() => startStream(camera), 5000);
        }
    });

    proc.on('error', (err) => {
        console.error(`[STREAM] Failed to start ${camera.name}: ${err.message}`);
        delete streamProcesses[camera.id];
    });

    streamProcesses[camera.id] = proc;
}

function stopStream(camId) {
    if (streamProcesses[camId]) {
        streamProcesses[camId].kill('SIGTERM');
        delete streamProcesses[camId];
    }
}

// ============== Recording Management ==============

function startRecording(camera) {
    if (recordProcesses[camera.id]) {
        return { success: false, message: 'Already recording' };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${camera.id}_${timestamp}.mp4`;
    const filepath = path.join(recordingsDir, filename);

    const args = [
        '-fflags', '+genpts+discardcorrupt',
        '-rtsp_transport', 'tcp',
        '-use_wallclock_as_timestamps', '1',
        '-i', camera.rtspUrl,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-r', '15',
        '-an',
        '-movflags', '+frag_keyframe+empty_moov',
        filepath
    ];

    console.log(`[RECORD] Starting recording for ${camera.name}: ${filename}`);

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.on('close', (code) => {
        console.log(`[RECORD] ${camera.name} recording ended: ${filename} (code ${code})`);
        delete recordProcesses[camera.id];
    });

    proc.on('error', (err) => {
        console.error(`[RECORD] Failed: ${err.message}`);
        delete recordProcesses[camera.id];
    });

    recordProcesses[camera.id] = {
        process: proc,
        filename,
        startTime: new Date()
    };

    return { success: true, filename };
}

function stopRecording(camId) {
    if (!recordProcesses[camId]) {
        return { success: false, message: 'Not recording' };
    }

    const rec = recordProcesses[camId];

    // Send 'q' to gracefully stop FFmpeg
    try {
        rec.process.stdin.write('q');
    } catch (e) {
        rec.process.kill('SIGTERM');
    }

    const duration = Math.round((new Date() - rec.startTime) / 1000);
    delete recordProcesses[camId];

    return { success: true, filename: rec.filename, duration };
}

// ============== API Routes ==============

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Serve HLS streams
app.use('/streams', express.static(streamsDir, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store');
        }
        if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
        }
    }
}));

// Serve recordings
app.use('/recordings-files', express.static(recordingsDir));

// === Camera endpoints ===
app.get('/api/cameras', (req, res) => {
    const cameras = config.cameras.map(c => ({
        ...c,
        streaming: !!streamProcesses[c.id],
        recording: !!recordProcesses[c.id],
        recordingInfo: recordProcesses[c.id] ? {
            filename: recordProcesses[c.id].filename,
            startTime: recordProcesses[c.id].startTime,
            duration: Math.round((new Date() - recordProcesses[c.id].startTime) / 1000)
        } : null
    }));
    res.json(cameras);
});

app.get('/api/cameras/:id/status', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    res.json({
        id: cam.id,
        name: cam.name,
        streaming: !!streamProcesses[cam.id],
        recording: !!recordProcesses[cam.id]
    });
});

app.post('/api/cameras/:id/restart', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    stopStream(cam.id);
    setTimeout(() => {
        startStream(cam);
        res.json({ success: true, message: `Restarting stream for ${cam.name}` });
    }, 1000);
});

// === Recording endpoints ===
app.post('/api/recording/start/:cameraId', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.cameraId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const result = startRecording(cam);
    res.json(result);
});

app.post('/api/recording/stop/:cameraId', (req, res) => {
    const result = stopRecording(req.params.cameraId);
    res.json(result);
});

app.get('/api/recordings', (req, res) => {
    try {
        const files = fs.readdirSync(recordingsDir)
            .filter(f => f.endsWith('.mp4'))
            .map(f => {
                const stat = fs.statSync(path.join(recordingsDir, f));
                const parts = f.replace('.mp4', '').split('_');
                const camId = parts[0];
                const cam = config.cameras.find(c => c.id === camId);
                return {
                    filename: f,
                    cameraId: camId,
                    cameraName: cam ? cam.name : camId,
                    size: stat.size,
                    sizeFormatted: formatBytes(stat.size),
                    created: stat.birthtime,
                    modified: stat.mtime,
                    url: `/recordings-files/${f}`
                };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));

        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

app.delete('/api/recordings/:filename', (req, res) => {
    const filepath = path.join(recordingsDir, req.params.filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

    try {
        fs.unlinkSync(filepath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === Screenshot (via FFmpeg) ===
app.post('/api/cameras/:id/screenshot', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot_${cam.id}_${timestamp}.jpg`;
    const filepath = path.join(recordingsDir, filename);

    const args = [
        '-fflags', '+genpts+discardcorrupt',
        '-rtsp_transport', 'tcp',
        '-use_wallclock_as_timestamps', '1',
        '-i', cam.rtspUrl,
        '-frames:v', '1',
        '-q:v', '2',
        filepath
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', (code) => {
        if (code === 0) {
            res.json({ success: true, filename, url: `/recordings-files/${filename}` });
        } else {
            res.status(500).json({ error: 'Screenshot failed' });
        }
    });
    proc.on('error', (err) => {
        res.status(500).json({ error: err.message });
    });
});

// ============== Utility ==============

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============== Start Server ==============

app.listen(config.serverPort, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║       AI HOME CAMERA - MONITORING SYSTEM     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Server running on http://localhost:${config.serverPort}     ║`);
    console.log(`║  Cameras configured: ${config.cameras.length}                      ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Auto-start all camera streams
    config.cameras.forEach(cam => {
        console.log(`[INIT] Starting stream for ${cam.name} (${cam.ip})`);
        startStream(cam);
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Stopping all streams and recordings...');
    Object.keys(streamProcesses).forEach(stopStream);
    Object.keys(recordProcesses).forEach(stopRecording);
    process.exit(0);
});

process.on('SIGTERM', () => {
    Object.keys(streamProcesses).forEach(stopStream);
    Object.keys(recordProcesses).forEach(stopRecording);
    process.exit(0);
});
