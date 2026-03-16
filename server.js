const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { Cam } = require('onvif');

// Load config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
app.use(cors());
app.use(express.json());

// Ensure directories exist
const streamsDir = path.resolve(config.streamsDir);
const recordingsDir = path.resolve(config.recordingsDir);
const dataDir = path.resolve(path.join(__dirname, 'data'));
[streamsDir, recordingsDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// SQLite database (persistent local metadata + user actions)
const dbPath = path.join(dataDir, 'camera_events.sqlite');
const db = new sqlite3.Database(dbPath);
const AUTH_COOKIE_NAME = 'ahc_auth';
const authSessions = new Map(); // token -> { email, expiresAtMs }

// Track active FFmpeg processes
const streamProcesses = {};   // { camId: childProcess }
const recordProcesses = {};   // { camId: { process, filename, startTime } }
const resolvedRtspSources = {}; // { camId: { url, fingerprint, duplicate } }
const ptzClients = {}; // { camId: onvif.Cam instance }
const motionProcesses = {}; // { camId: childProcess }
const motionLastTriggerAt = {}; // { camId: timestampMs }
const motionRecordTimers = {}; // { camId: timeoutId }
const cameraRuntime = {}; // { camId: { qualityMode, motionEnabled } }

config.cameras.forEach((camera) => {
    cameraRuntime[camera.id] = {
        qualityMode: String(camera.qualityMode || 'hd').toLowerCase() === 'sd' ? 'sd' : 'hd',
        motionEnabled: !!camera.motionDetection?.enabled
    };
});

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function initDatabase() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            camera_id TEXT NOT NULL,
            camera_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            url TEXT NOT NULL,
            status TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            duration_seconds INTEGER,
            size_bytes INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            deleted_at TEXT
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS action_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            camera_id TEXT,
            camera_name TEXT,
            details_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    await dbRun(`CREATE INDEX IF NOT EXISTS idx_recordings_camera_id ON recordings(camera_id)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_recordings_deleted_at ON recordings(deleted_at)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_action_logs_created_at ON action_logs(created_at)`);
}

function logUserAction(actionType, camera, details = {}) {
    const cameraId = camera?.id || null;
    const cameraName = camera?.name || null;
    return dbRun(
        `INSERT INTO action_logs (action_type, camera_id, camera_name, details_json)
         VALUES (?, ?, ?, ?)`,
        [actionType, cameraId, cameraName, JSON.stringify(details)]
    ).catch((err) => {
        console.error(`[DB] Failed to store action log (${actionType}): ${err.message}`);
    });
}

function upsertRecordingState(payload) {
    return dbRun(
        `INSERT INTO recordings (
            filename, camera_id, camera_name, file_path, url, status, start_time, end_time,
            duration_seconds, size_bytes, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
         ON CONFLICT(filename) DO UPDATE SET
            camera_id = excluded.camera_id,
            camera_name = excluded.camera_name,
            file_path = excluded.file_path,
            url = excluded.url,
            status = excluded.status,
            start_time = COALESCE(excluded.start_time, recordings.start_time),
            end_time = COALESCE(excluded.end_time, recordings.end_time),
            duration_seconds = COALESCE(excluded.duration_seconds, recordings.duration_seconds),
            size_bytes = COALESCE(excluded.size_bytes, recordings.size_bytes),
            updated_at = datetime('now'),
            deleted_at = excluded.deleted_at`,
        [
            payload.filename,
            payload.cameraId,
            payload.cameraName,
            payload.filePath,
            payload.url,
            payload.status || 'saved',
            payload.startTime || null,
            payload.endTime || null,
            Number.isInteger(payload.durationSeconds) ? payload.durationSeconds : null,
            Number.isInteger(payload.sizeBytes) ? payload.sizeBytes : 0,
        ]
    );
}

async function syncRecordingsFromDisk() {
    try {
        const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.mp4'));
        for (const filename of files) {
            const filePath = path.join(recordingsDir, filename);
            const stat = fs.statSync(filePath);
            const camId = filename.replace('.mp4', '').split('_')[0];
            const cam = config.cameras.find(c => c.id === camId);

            await upsertRecordingState({
                filename,
                cameraId: camId,
                cameraName: cam ? cam.name : camId,
                filePath,
                url: `/recordings-files/${filename}`,
                status: 'saved',
                startTime: stat.birthtime ? stat.birthtime.toISOString() : null,
                endTime: stat.mtime ? stat.mtime.toISOString() : null,
                sizeBytes: stat.size
            });
        }
    } catch (err) {
        console.error(`[DB] Failed syncing recordings from disk: ${err.message}`);
    }
}

function parseJsonSafe(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function getAuthConfig() {
    return config.auth || {};
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    return header.split(';').reduce((acc, part) => {
        const [k, ...rest] = part.trim().split('=');
        if (!k) return acc;
        acc[k] = decodeURIComponent(rest.join('=') || '');
        return acc;
    }, {});
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of authSessions.entries()) {
        if (!session || session.expiresAtMs <= now) {
            authSessions.delete(token);
        }
    }
}

function getSessionFromRequest(req) {
    cleanExpiredSessions();
    const cookies = parseCookies(req);
    const token = cookies[AUTH_COOKIE_NAME];
    if (!token) return null;
    const session = authSessions.get(token);
    if (!session) return null;
    if (session.expiresAtMs <= Date.now()) {
        authSessions.delete(token);
        return null;
    }
    return { token, ...session };
}

function issueSession(res, email) {
    const authCfg = getAuthConfig();
    const hours = Number(authCfg.sessionHours || 24);
    const expiresAtMs = Date.now() + Math.max(1, hours) * 60 * 60 * 1000;
    const token = crypto.randomBytes(24).toString('hex');
    authSessions.set(token, { email, expiresAtMs });

    const maxAgeSec = Math.floor((expiresAtMs - Date.now()) / 1000);
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`
    );
}

function clearSession(res, req) {
    const session = getSessionFromRequest(req);
    if (session?.token) authSessions.delete(session.token);
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function requireAuthApi(req, res, next) {
    const session = getSessionFromRequest(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    req.authSession = session;
    next();
}

function requireAuthPage(req, res, next) {
    const session = getSessionFromRequest(req);
    if (!session) return res.redirect('/login.html');
    req.authSession = session;
    next();
}

function getPtzConfig(camera) {
    if (!camera?.ptz?.enabled) return null;
    return camera.ptz;
}

function getCameraPublicData(camera) {
    const runtime = cameraRuntime[camera.id] || { qualityMode: 'hd', motionEnabled: false };
    return {
        id: camera.id,
        name: camera.name,
        ip: camera.ip,
        port: camera.port,
        ptzEnabled: !!getPtzConfig(camera),
        qualityMode: runtime.qualityMode,
        motionEnabled: runtime.motionEnabled
    };
}

function getQualityProfile(camera) {
    const mode = cameraRuntime[camera.id]?.qualityMode || 'hd';
    const defaults = {
        hd: { fps: 15, gop: 30, crf: 23, scaleWidth: null },
        sd: { fps: 10, gop: 20, crf: 30, scaleWidth: 960 }
    };
    const customProfiles = camera.streamQualityProfiles || {};
    return { mode, ...defaults[mode], ...(customProfiles[mode] || {}) };
}

function getMotionConfig(camera) {
    const cfg = camera.motionDetection || {};
    return {
        threshold: Number(cfg.threshold ?? 0.08),
        cooldownMs: Math.max(1000, Number(cfg.cooldownMs ?? 15000)),
        recordDurationSec: Math.max(10, Number(cfg.recordDurationSec ?? 120)),
        screenshotOnMotion: cfg.screenshotOnMotion !== false,
        autoRecordOnMotion: cfg.autoRecordOnMotion !== false
    };
}

function createOnvifClient(camera, ptzConfig) {
    return new Promise((resolve, reject) => {
        const hostname = ptzConfig.host || camera.ip;
        const port = ptzConfig.port || 80;
        const username = ptzConfig.username || camera.username;
        const password = ptzConfig.password || camera.password;

        new Cam({
            hostname,
            port,
            username,
            password
        }, function onReady(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

async function getPtzClient(camera) {
    const existing = ptzClients[camera.id];
    if (existing) return existing;

    const ptzConfig = getPtzConfig(camera);
    if (!ptzConfig) throw new Error('PTZ not enabled for this camera');

    if ((ptzConfig.protocol || 'onvif').toLowerCase() !== 'onvif') {
        throw new Error(`Unsupported PTZ protocol: ${ptzConfig.protocol}`);
    }

    const client = await createOnvifClient(camera, ptzConfig);
    ptzClients[camera.id] = client;
    return client;
}

function onvifContinuousMove(client, options) {
    return new Promise((resolve, reject) => {
        client.continuousMove(options, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function onvifStop(client, options = { panTilt: true, zoom: true }) {
    return new Promise((resolve, reject) => {
        client.stop(options, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function getPtzVector(direction, speed) {
    const s = Math.max(0.05, Math.min(1, Number(speed) || 0.5));
    switch (direction) {
        case 'up': return { x: 0, y: s, zoom: 0 };
        case 'down': return { x: 0, y: -s, zoom: 0 };
        case 'left': return { x: -s, y: 0, zoom: 0 };
        case 'right': return { x: s, y: 0, zoom: 0 };
        case 'up-left': return { x: -s, y: s, zoom: 0 };
        case 'up-right': return { x: s, y: s, zoom: 0 };
        case 'down-left': return { x: -s, y: -s, zoom: 0 };
        case 'down-right': return { x: s, y: -s, zoom: 0 };
        case 'zoom-in': return { x: 0, y: 0, zoom: s };
        case 'zoom-out': return { x: 0, y: 0, zoom: -s };
        default: return null;
    }
}

function stopMotionRecordingTimer(camId) {
    if (motionRecordTimers[camId]) {
        clearTimeout(motionRecordTimers[camId]);
        delete motionRecordTimers[camId];
    }
}

function captureScreenshotInternal(camera, reason = 'manual') {
    return new Promise((resolve, reject) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${camera.id}_${timestamp}.jpg`;
        const filepath = path.join(recordingsDir, filename);
        const rtspSource = getCameraRtspUrl(camera);
        const args = [
            '-fflags', '+genpts+discardcorrupt',
            '-rtsp_transport', 'tcp',
            '-use_wallclock_as_timestamps', '1',
            '-i', rtspSource
        ];

        appendCameraVideoFilterArgs(camera, args);
        args.push('-frames:v', '1', '-q:v', '2', filepath);

        const proc = spawn('ffmpeg', args);
        proc.on('close', (code) => {
            if (code === 0) {
                logUserAction('screenshot_capture', camera, {
                    filename,
                    path: filepath,
                    reason
                });
                resolve({ success: true, filename, url: `/recordings-files/${filename}` });
            } else {
                reject(new Error('Screenshot failed'));
            }
        });
        proc.on('error', (err) => reject(err));
    });
}

function scheduleMotionAutoStop(camera, durationSec) {
    stopMotionRecordingTimer(camera.id);
    motionRecordTimers[camera.id] = setTimeout(() => {
        const active = recordProcesses[camera.id];
        if (active && active.startedByMotion) {
            const result = stopRecording(camera.id);
            logUserAction('motion_recording_auto_stop', camera, {
                filename: result.filename,
                durationSeconds: result.duration
            });
        }
        delete motionRecordTimers[camera.id];
    }, durationSec * 1000);
}

function handleMotionDetected(camera, meta = {}) {
    const now = Date.now();
    const cfg = getMotionConfig(camera);
    const last = motionLastTriggerAt[camera.id] || 0;
    if (now - last < cfg.cooldownMs) return;
    motionLastTriggerAt[camera.id] = now;

    logUserAction('motion_detected', camera, {
        at: new Date().toISOString(),
        ...meta
    });

    if (cfg.screenshotOnMotion) {
        captureScreenshotInternal(camera, 'motion').catch((err) => {
            console.error(`[MOTION] Screenshot failed for ${camera.name}: ${err.message}`);
        });
    }

    if (cfg.autoRecordOnMotion) {
        const active = recordProcesses[camera.id];
        if (!active) {
            const result = startRecording(camera, { startedByMotion: true, reason: 'motion' });
            if (result.success) {
                logUserAction('motion_recording_started', camera, {
                    filename: result.filename,
                    durationSec: cfg.recordDurationSec
                });
            }
        }
        if (recordProcesses[camera.id]?.startedByMotion) {
            scheduleMotionAutoStop(camera, cfg.recordDurationSec);
        }
    }
}

function stopMotionDetection(camId) {
    if (motionProcesses[camId]) {
        try { motionProcesses[camId].kill('SIGTERM'); } catch (e) { }
        delete motionProcesses[camId];
    }
    stopMotionRecordingTimer(camId);
}

async function startMotionDetection(camera) {
    const runtime = cameraRuntime[camera.id];
    if (!runtime?.motionEnabled) return;
    if (motionProcesses[camera.id]) return;

    let rtspSource = getCameraRtspUrl(camera);
    try {
        const resolved = await resolveCameraRtspSource(camera);
        rtspSource = resolved.url;
    } catch (err) {
        console.error(`[MOTION] Resolve failed for ${camera.name}: ${err.message}`);
    }

    const cfg = getMotionConfig(camera);
    const motionFilter = `fps=2,select='gt(scene\\,${cfg.threshold.toFixed(4)})',showinfo`;
    const args = [
        '-loglevel', 'info',
        '-rtsp_transport', 'tcp',
        '-i', rtspSource
    ];
    appendCameraVideoFilterArgs(camera, args, [motionFilter]);
    args.push('-an', '-f', 'null', '-');

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    motionProcesses[camera.id] = proc;
    // Warmup window avoids startup false-positive motion events.
    motionLastTriggerAt[camera.id] = Date.now();
    console.log(`[MOTION] Started detector for ${camera.name}`);

    proc.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.includes('showinfo')) {
            const pts = text.match(/pts_time:([0-9.]+)/);
            handleMotionDetected(camera, { ptsTime: pts ? Number(pts[1]) : null });
        }
    });

    proc.on('close', (code) => {
        delete motionProcesses[camera.id];
        if (cameraRuntime[camera.id]?.motionEnabled) {
            setTimeout(() => startMotionDetection(camera), 3000);
        }
        if (code !== 0 && code !== null) {
            console.warn(`[MOTION] Detector exited for ${camera.name} with code ${code}`);
        }
    });

    proc.on('error', (err) => {
        delete motionProcesses[camera.id];
        console.error(`[MOTION] Failed for ${camera.name}: ${err.message}`);
    });
}

// ============== FFmpeg Stream Management ==============

function getRtspCandidates(camera) {
    const baseCandidates = [];

    if (typeof camera.rtspUrl === 'string' && camera.rtspUrl.trim()) {
        baseCandidates.push(camera.rtspUrl.trim());
    }

    if (Array.isArray(camera.rtspCandidates)) {
        camera.rtspCandidates.forEach(url => {
            if (typeof url === 'string' && url.trim()) {
                baseCandidates.push(url.trim());
            }
        });
    }

    const candidates = [];
    baseCandidates.forEach((url) => {
        candidates.push(url);
        const authUrl = applyRtspAuth(url, camera);
        if (authUrl !== url) candidates.push(authUrl);
    });

    return [...new Set(candidates)];
}

function getCameraRtspUrl(camera) {
    return resolvedRtspSources[camera.id]?.url || camera.rtspUrl;
}

function appendCameraVideoFilterArgs(camera, args, extraFilters = []) {
    const filters = [];
    if (typeof camera.ffmpegVideoFilter === 'string' && camera.ffmpegVideoFilter.trim()) {
        filters.push(camera.ffmpegVideoFilter.trim());
    }
    if (Array.isArray(extraFilters) && extraFilters.length) {
        filters.push(...extraFilters.filter(Boolean));
    }
    if (filters.length) {
        args.push('-vf', filters.join(','));
    }
}

function maskRtspCredentials(rtspUrl) {
    try {
        const parsed = new URL(rtspUrl);
        if (parsed.username) parsed.username = '***';
        if (parsed.password) parsed.password = '***';
        return parsed.toString();
    } catch (err) {
        return rtspUrl;
    }
}

function applyRtspAuth(rtspUrl, camera) {
    const username = camera.username || camera.authUsername;
    const password = camera.password || camera.authPassword;
    if (!username) return rtspUrl;

    try {
        const parsed = new URL(rtspUrl);
        if (!parsed.username) parsed.username = username;
        if (!parsed.password && password) parsed.password = password;
        return parsed.toString();
    } catch (err) {
        return rtspUrl;
    }
}

function probeRtspCandidate(rtspUrl, timeoutMs = 7000) {
    return new Promise((resolve) => {
        const probeDir = path.join(streamsDir, '_probe');
        if (!fs.existsSync(probeDir)) fs.mkdirSync(probeDir, { recursive: true });

        const probeFile = path.join(
            probeDir,
            `probe_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`
        );

        const args = [
            '-y',
            '-loglevel', 'error',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-frames:v', '1',
            '-q:v', '2',
            probeFile
        ];

        let done = false;
        let stderrText = '';
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
            } catch (e) { }
            resolve(result);
        };

        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) { }
            finish({ ok: false, url: rtspUrl, reason: 'timeout' });
        }, timeoutMs + 1000);

        proc.stderr.on('data', (d) => { stderrText += d.toString(); });

        proc.on('error', (err) => {
            finish({ ok: false, url: rtspUrl, reason: err.message });
        });

        proc.on('close', (code) => {
            if (fs.existsSync(probeFile)) {
                const buf = fs.readFileSync(probeFile);
                const fingerprint = crypto.createHash('sha1').update(buf).digest('hex');
                finish({ ok: true, url: rtspUrl, fingerprint });
            } else {
                const cleanErr = stderrText.trim().split('\n').slice(-1)[0] || `exit_${code}`;
                finish({ ok: false, url: rtspUrl, reason: cleanErr });
            }
        });
    });
}

async function resolveCameraRtspSource(camera) {
    if (camera.disableRtspProbe) {
        const direct = {
            ip: camera.ip,
            url: camera.rtspUrl,
            fingerprint: null,
            duplicate: false
        };
        resolvedRtspSources[camera.id] = direct;
        console.log(`[RTSP] ${camera.name} using configured URL ${camera.rtspUrl}`);
        return direct;
    }

    const existing = resolvedRtspSources[camera.id];
    if (existing?.url) return existing;

    const candidates = getRtspCandidates(camera);
    if (candidates.length === 0) {
        throw new Error(`No RTSP URLs configured for ${camera.name}`);
    }

    let firstWorking = null;

    for (const candidate of candidates) {
        const result = await probeRtspCandidate(candidate);
        if (!result.ok) {
            console.log(`[RTSP] Candidate failed for ${camera.name}: ${candidate} (${result.reason})`);
            continue;
        }

        if (!firstWorking) firstWorking = result;

        const sameIpFingerprints = Object.values(resolvedRtspSources)
            .filter(src => src?.ip === camera.ip && src.fingerprint)
            .map(src => src.fingerprint);

        const isDuplicate = sameIpFingerprints.includes(result.fingerprint);
        if (!isDuplicate) {
            const resolved = {
                ip: camera.ip,
                url: result.url,
                fingerprint: result.fingerprint,
                duplicate: false
            };
            resolvedRtspSources[camera.id] = resolved;
            console.log(`[RTSP] ${camera.name} resolved to ${result.url}`);
            return resolved;
        }
    }

    if (firstWorking) {
        const fallback = {
            ip: camera.ip,
            url: firstWorking.url,
            fingerprint: firstWorking.fingerprint,
            duplicate: true
        };
        resolvedRtspSources[camera.id] = fallback;
        console.warn(`[RTSP] ${camera.name} fallback to duplicate stream: ${firstWorking.url}`);
        return fallback;
    }

    const directFallback = {
        ip: camera.ip,
        url: camera.rtspUrl,
        fingerprint: null,
        duplicate: false
    };
    resolvedRtspSources[camera.id] = directFallback;
    console.warn(`[RTSP] ${camera.name} could not be probed; using primary URL ${camera.rtspUrl}`);
    return directFallback;
}

async function startStream(camera) {
    if (streamProcesses[camera.id]) {
        console.log(`[STREAM] ${camera.name} already streaming`);
        return;
    }

    let rtspSource = getCameraRtspUrl(camera);
    try {
        const resolved = await resolveCameraRtspSource(camera);
        rtspSource = resolved.url;
    } catch (err) {
        console.error(`[RTSP] Resolve failed for ${camera.name}: ${err.message}`);
    }

    const camStreamDir = path.join(streamsDir, camera.id);
    if (!fs.existsSync(camStreamDir)) fs.mkdirSync(camStreamDir, { recursive: true });

    // Clean old segments
    fs.readdirSync(camStreamDir).forEach(f => {
        fs.unlinkSync(path.join(camStreamDir, f));
    });

    const quality = getQualityProfile(camera);
    const extraFilters = [];
    if (quality.scaleWidth) {
        extraFilters.push(`scale=${quality.scaleWidth}:-2`);
    }

    const args = [
        '-fflags', '+genpts+discardcorrupt',
        '-rtsp_transport', 'tcp',
        '-use_wallclock_as_timestamps', '1',
        '-i', rtspSource
    ];

    appendCameraVideoFilterArgs(camera, args, extraFilters);

    args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', String(quality.crf),
        '-r', String(quality.fps),
        '-g', String(quality.gop),
        '-an',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_allow_cache', '0',
        path.join(camStreamDir, 'stream.m3u8')
    );

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

function startRecording(camera, options = {}) {
    if (recordProcesses[camera.id]) {
        return { success: false, message: 'Already recording' };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${camera.id}_${timestamp}.mp4`;
    const filepath = path.join(recordingsDir, filename);
    const startTime = new Date();

    const rtspSource = getCameraRtspUrl(camera);
    const args = [
        '-fflags', '+genpts+discardcorrupt',
        '-rtsp_transport', 'tcp',
        '-use_wallclock_as_timestamps', '1',
        '-i', rtspSource
    ];

    appendCameraVideoFilterArgs(camera, args);

    args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-r', '15',
        '-an',
        '-movflags', '+frag_keyframe+empty_moov',
        filepath
    );

    console.log(`[RECORD] Starting recording for ${camera.name}: ${filename}`);

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    upsertRecordingState({
        filename,
        cameraId: camera.id,
        cameraName: camera.name,
        filePath: filepath,
        url: `/recordings-files/${filename}`,
        status: 'recording',
        startTime: startTime.toISOString(),
        sizeBytes: 0
    }).catch((err) => {
        console.error(`[DB] Failed to store recording start for ${filename}: ${err.message}`);
    });

    logUserAction('recording_start', camera, {
        filename,
        path: filepath,
        reason: options.reason || 'manual'
    });

    proc.on('close', (code) => {
        console.log(`[RECORD] ${camera.name} recording ended: ${filename} (code ${code})`);
        delete recordProcesses[camera.id];

        const endTime = new Date();
        const duration = Math.max(0, Math.round((endTime - startTime) / 1000));
        const sizeBytes = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
        const status = code === 0 ? 'saved' : 'failed';

        upsertRecordingState({
            filename,
            cameraId: camera.id,
            cameraName: camera.name,
            filePath: filepath,
            url: `/recordings-files/${filename}`,
            status,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            durationSeconds: duration,
            sizeBytes
        }).catch((err) => {
            console.error(`[DB] Failed to finalize recording ${filename}: ${err.message}`);
        });

        logUserAction('recording_process_exit', camera, {
            filename,
            exitCode: code,
            status,
            durationSeconds: duration,
            path: filepath
        });
    });

    proc.on('error', (err) => {
        console.error(`[RECORD] Failed: ${err.message}`);
        delete recordProcesses[camera.id];
    });

    recordProcesses[camera.id] = {
        process: proc,
        filename,
        startTime,
        filepath,
        startedByMotion: !!options.startedByMotion
    };

    return { success: true, filename };
}

function stopRecording(camId) {
    if (!recordProcesses[camId]) {
        return { success: false, message: 'Not recording' };
    }

    const rec = recordProcesses[camId];
    const camera = config.cameras.find(c => c.id === camId);

    // Send 'q' to gracefully stop FFmpeg
    try {
        rec.process.stdin.write('q');
    } catch (e) {
        rec.process.kill('SIGTERM');
    }

    const duration = Math.round((new Date() - rec.startTime) / 1000);
    delete recordProcesses[camId];
    stopMotionRecordingTimer(camId);

    upsertRecordingState({
        filename: rec.filename,
        cameraId: camId,
        cameraName: camera ? camera.name : camId,
        filePath: rec.filepath,
        url: `/recordings-files/${rec.filename}`,
        status: 'stopping',
        startTime: rec.startTime.toISOString(),
        durationSeconds: duration,
        sizeBytes: fs.existsSync(rec.filepath) ? fs.statSync(rec.filepath).size : 0
    }).catch((err) => {
        console.error(`[DB] Failed to mark recording stopping (${rec.filename}): ${err.message}`);
    });

    logUserAction('recording_stop', camera, {
        filename: rec.filename,
        durationSeconds: duration,
        path: rec.filepath
    });

    return { success: true, filename: rec.filename, duration };
}

// ============== API Routes ==============

// Public auth pages/assets
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login.html', (req, res) => {
    const session = getSessionFromRequest(req);
    if (session) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/recordings.html', requireAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recordings.html'));
});

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const authCfg = getAuthConfig();
    const configuredEmail = String(authCfg.email || '').trim().toLowerCase();
    const configuredPassword = String(authCfg.password || '');

    if (email !== configuredEmail || password !== configuredPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    issueSession(res, configuredEmail);
    logUserAction('auth_login', null, { email: configuredEmail });
    res.json({ success: true, email: configuredEmail });
});

app.post('/api/auth/logout', (req, res) => {
    const session = getSessionFromRequest(req);
    if (session?.email) {
        logUserAction('auth_logout', null, { email: session.email });
    }
    clearSession(res, req);
    res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
    const session = getSessionFromRequest(req);
    if (!session) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, email: session.email });
});

// Protect all API routes below except /api/auth/*
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    return requireAuthApi(req, res, next);
});

// Serve HLS streams
app.use('/streams', requireAuthPage, express.static(streamsDir, {
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
app.use('/recordings-files', requireAuthPage, express.static(recordingsDir));

// === Camera endpoints ===
app.get('/api/cameras', (req, res) => {
    const cameras = config.cameras.map(c => ({
        ...getCameraPublicData(c),
        activeRtspUrl: maskRtspCredentials(getCameraRtspUrl(c)),
        rtspResolved: !!resolvedRtspSources[c.id],
        rtspDuplicateFallback: !!resolvedRtspSources[c.id]?.duplicate,
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
        ...getCameraPublicData(cam),
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
        logUserAction('stream_restart', cam, { reason: 'user_request' });
        res.json({ success: true, message: `Restarting stream for ${cam.name}` });
    }, 1000);
});

app.post('/api/cameras/:id/quality', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const mode = String(req.body?.mode || '').toLowerCase();
    if (!['hd', 'sd'].includes(mode)) {
        return res.status(400).json({ error: 'Quality mode must be hd or sd' });
    }

    cameraRuntime[cam.id].qualityMode = mode;
    stopStream(cam.id);
    setTimeout(() => startStream(cam), 800);

    logUserAction('quality_mode_change', cam, { mode });
    res.json({ success: true, cameraId: cam.id, mode });
});

app.post('/api/cameras/:id/motion', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const enabled = !!req.body?.enabled;
    cameraRuntime[cam.id].motionEnabled = enabled;

    if (enabled) {
        startMotionDetection(cam).catch((err) => {
            console.error(`[MOTION] Enable failed for ${cam.name}: ${err.message}`);
        });
    } else {
        stopMotionDetection(cam.id);
    }

    logUserAction('motion_toggle', cam, { enabled });
    res.json({ success: true, cameraId: cam.id, motionEnabled: enabled });
});

app.post('/api/cameras/:id/ptz/move', async (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const ptzConfig = getPtzConfig(cam);
    if (!ptzConfig) return res.status(400).json({ error: 'PTZ not enabled for this camera' });

    const direction = String(req.body?.direction || '').toLowerCase();
    const speed = req.body?.speed ?? ptzConfig.defaultSpeed ?? 0.5;
    const durationMsRaw = req.body?.durationMs ?? ptzConfig.defaultDurationMs ?? 500;
    const durationMs = Math.max(100, Math.min(3000, Number(durationMsRaw) || 500));
    const vector = getPtzVector(direction, speed);

    if (!vector) {
        return res.status(400).json({ error: 'Invalid PTZ direction' });
    }

    try {
        const client = await getPtzClient(cam);
        await onvifContinuousMove(client, { ...vector, timeout: durationMs / 1000 });

        logUserAction('ptz_move', cam, { direction, speed: Number(speed), durationMs });
        res.json({ success: true, direction, speed: Number(speed), durationMs });
    } catch (err) {
        console.error(`[PTZ] Move failed for ${cam.name}: ${err.message}`);
        delete ptzClients[cam.id];
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/cameras/:id/ptz/stop', async (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const ptzConfig = getPtzConfig(cam);
    if (!ptzConfig) return res.status(400).json({ error: 'PTZ not enabled for this camera' });

    try {
        const client = await getPtzClient(cam);
        await onvifStop(client, { panTilt: true, zoom: true });
        logUserAction('ptz_stop', cam, {});
        res.json({ success: true });
    } catch (err) {
        console.error(`[PTZ] Stop failed for ${cam.name}: ${err.message}`);
        delete ptzClients[cam.id];
        res.status(500).json({ error: err.message });
    }
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

app.get('/api/recordings', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT
                filename, camera_id, camera_name, size_bytes, start_time, end_time, updated_at, url, status
             FROM recordings
             WHERE deleted_at IS NULL
             ORDER BY COALESCE(end_time, start_time, updated_at) DESC`
        );

        const files = rows.map((row) => ({
            filename: row.filename,
            cameraId: row.camera_id,
            cameraName: row.camera_name,
            size: row.size_bytes || 0,
            sizeFormatted: formatBytes(row.size_bytes || 0),
            created: row.start_time || row.updated_at,
            modified: row.end_time || row.updated_at,
            status: row.status,
            url: row.url || `/recordings-files/${row.filename}`
        }));

        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

app.delete('/api/recordings/:filename', async (req, res) => {
    const filepath = path.join(recordingsDir, req.params.filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

    try {
        fs.unlinkSync(filepath);
        await dbRun(
            `UPDATE recordings
             SET status = 'deleted', deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE filename = ?`,
            [req.params.filename]
        );
        logUserAction('recording_delete', null, {
            filename: req.params.filename,
            path: filepath
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === Screenshot (via FFmpeg) ===
app.post('/api/cameras/:id/screenshot', (req, res) => {
    const cam = config.cameras.find(c => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    captureScreenshotInternal(cam, 'manual')
        .then((result) => res.json(result))
        .catch((err) => res.status(500).json({ error: err.message }));
});

app.get('/api/actions', async (req, res) => {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 500)
        : 100;

    try {
        const rows = await dbAll(
            `SELECT id, action_type, camera_id, camera_name, details_json, created_at
             FROM action_logs
             ORDER BY id DESC
             LIMIT ?`,
            [limit]
        );

        res.json(rows.map((row) => ({
            id: row.id,
            actionType: row.action_type,
            cameraId: row.camera_id,
            cameraName: row.camera_name,
            details: parseJsonSafe(row.details_json, {}),
            createdAt: row.created_at
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

initDatabase()
    .then(() => syncRecordingsFromDisk())
    .then(() => {
        console.log(`[DB] SQLite ready at ${dbPath}`);

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
                if (cameraRuntime[cam.id]?.motionEnabled) {
                    startMotionDetection(cam).catch((err) => {
                        console.error(`[MOTION] Startup failed for ${cam.name}: ${err.message}`);
                    });
                }
            });
        });
    })
    .catch((err) => {
        console.error(`[DB] Failed to initialize SQLite: ${err.message}`);
        process.exit(1);
    });

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Stopping all streams and recordings...');
    Object.keys(streamProcesses).forEach(stopStream);
    Object.keys(recordProcesses).forEach(stopRecording);
    Object.keys(motionProcesses).forEach(stopMotionDetection);
    Object.keys(ptzClients).forEach((camId) => { delete ptzClients[camId]; });
    db.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
    Object.keys(streamProcesses).forEach(stopStream);
    Object.keys(recordProcesses).forEach(stopRecording);
    Object.keys(motionProcesses).forEach(stopMotionDetection);
    Object.keys(ptzClients).forEach((camId) => { delete ptzClients[camId]; });
    db.close(() => process.exit(0));
});
