// ============================================
// AI HOME CAMERA — Dashboard App
// ============================================

const API_BASE = window.location.origin;
let cameras = [];
let hlsInstances = {};
let pollInterval = null;

// ============== Init ==============

document.addEventListener('DOMContentLoaded', () => {
    startClock();
    fetchCameras();
    pollInterval = setInterval(fetchCameraStatus, 5000);
    fetchRecordingsCount();

    // Fullscreen modal close
    document.getElementById('btn-close-fullscreen').addEventListener('click', closeFullscreen);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeFullscreen();
    });
});

// ============== Clock ==============

function startClock() {
    const clockEl = document.getElementById('system-clock');
    function update() {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
    }
    update();
    setInterval(update, 1000);
}

// ============== Camera Data ==============

async function fetchCameras() {
    try {
        const res = await fetch(`${API_BASE}/api/cameras`);
        cameras = await res.json();
        renderCameraGrid();
        updateStats();
    } catch (err) {
        console.error('Failed to fetch cameras:', err);
        showToast('Failed to connect to server', 'error');
    }
}

async function fetchCameraStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/cameras`);
        cameras = await res.json();
        updateStats();
        updateCameraStatuses();
    } catch (err) {
        // Server offline
        document.getElementById('server-status').querySelector('.status-dot').className = 'status-dot offline';
    }
}

async function fetchRecordingsCount() {
    try {
        const res = await fetch(`${API_BASE}/api/recordings`);
        const recordings = await res.json();
        document.getElementById('stat-saved').textContent = recordings.length;
    } catch (err) {
        // ignore
    }
}

// ============== Render Camera Grid ==============

function renderCameraGrid() {
    const grid = document.getElementById('camera-grid');
    grid.innerHTML = '';

    cameras.forEach(cam => {
        const card = document.createElement('div');
        card.className = `camera-card ${cam.recording ? 'recording' : ''}`;
        card.id = `card-${cam.id}`;
        card.innerHTML = `
      <div class="camera-header">
        <div class="camera-info">
          <div class="camera-status-dot ${cam.streaming ? 'online' : 'offline'}" id="dot-${cam.id}"></div>
          <div>
            <div class="camera-name">${cam.name.toUpperCase()}</div>
            <div class="camera-ip">${cam.ip}:${cam.port} • RTSP</div>
          </div>
        </div>
        <div class="camera-live-badge" id="badge-${cam.id}">
          <span class="live-dot"></span>
          LIVE
        </div>
      </div>
      <div class="camera-video-container" id="video-container-${cam.id}">
        <video id="video-${cam.id}" autoplay muted playsinline></video>
        <div class="camera-timestamp" id="timestamp-${cam.id}"></div>
        <div class="camera-rec-indicator ${cam.recording ? 'active' : ''}" id="rec-indicator-${cam.id}">
          <span class="rec-dot"></span>
          REC
          <span class="rec-timer" id="rec-timer-${cam.id}">00:00</span>
        </div>
        <div class="camera-offline-overlay ${cam.streaming ? '' : 'active'}" id="offline-${cam.id}">
          <div class="offline-icon">📷</div>
          <div class="offline-text">CONNECTING...</div>
        </div>
      </div>
      <div class="camera-controls">
        <button class="cam-btn btn-record ${cam.recording ? 'recording' : ''}" id="btn-rec-${cam.id}" onclick="toggleRecording('${cam.id}')">
          ${cam.recording ? '⏹ STOP REC' : '⏺ RECORD'}
        </button>
        <button class="cam-btn btn-screenshot" onclick="takeScreenshot('${cam.id}')">
          📸 CAPTURE
        </button>
        <button class="cam-btn btn-fullscreen" onclick="openFullscreen('${cam.id}')">
          ⛶ EXPAND
        </button>
        <button class="cam-btn btn-restart" onclick="restartStream('${cam.id}')">
          ↻ RESTART
        </button>
      </div>
    `;
        grid.appendChild(card);

        // Initialize HLS stream
        initHLSStream(cam.id);

        // Start timestamp
        updateTimestamp(cam.id);
    });
}

// ============== HLS Stream ==============

function initHLSStream(camId) {
    const video = document.getElementById(`video-${camId}`);
    const hlsUrl = `${API_BASE}/streams/${camId}/stream.m3u8`;

    // Destroy existing instance
    if (hlsInstances[camId]) {
        hlsInstances[camId].destroy();
        delete hlsInstances[camId];
    }

    if (Hls.isSupported()) {
        const hls = new Hls({
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            enableWorker: true,
            lowLatencyMode: true,
            maxBufferLength: 10,
            maxMaxBufferLength: 20,
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 10,
            manifestLoadingRetryDelay: 2000,
            levelLoadingTimeOut: 10000,
            levelLoadingMaxRetry: 10,
            fragLoadingTimeOut: 10000,
        });

        hls.loadSource(hlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => { });
            showCameraOnline(camId);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        // Retry in 3 seconds
                        setTimeout(() => {
                            hls.loadSource(hlsUrl);
                        }, 3000);
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        hls.recoverMediaError();
                        break;
                    default:
                        hls.destroy();
                        showCameraOffline(camId);
                        // Retry full init in 5 seconds
                        setTimeout(() => initHLSStream(camId), 5000);
                        break;
                }
            }
        });

        hlsInstances[camId] = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        video.src = hlsUrl;
        video.addEventListener('loadedmetadata', () => {
            video.play().catch(() => { });
            showCameraOnline(camId);
        });
    }
}

function showCameraOnline(camId) {
    const dot = document.getElementById(`dot-${camId}`);
    const overlay = document.getElementById(`offline-${camId}`);
    if (dot) dot.className = 'camera-status-dot online';
    if (overlay) overlay.classList.remove('active');
}

function showCameraOffline(camId) {
    const dot = document.getElementById(`dot-${camId}`);
    const overlay = document.getElementById(`offline-${camId}`);
    if (dot) dot.className = 'camera-status-dot offline';
    if (overlay) overlay.classList.add('active');
}

// ============== Status Updates ==============

function updateStats() {
    const streaming = cameras.filter(c => c.streaming).length;
    const recording = cameras.filter(c => c.recording).length;

    document.getElementById('stat-streaming').textContent = streaming;
    document.getElementById('stat-recording').textContent = recording;

    // Date
    const now = new Date();
    document.getElementById('stat-date').textContent = now.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });

    // Camera status indicator
    const camDot = document.getElementById('cam-status-dot');
    const camLabel = document.getElementById('cam-count-label');
    camLabel.textContent = `${streaming}/${cameras.length} ONLINE`;

    if (streaming === cameras.length) {
        camDot.className = 'status-dot online';
    } else if (streaming > 0) {
        camDot.className = 'status-dot partial';
    } else {
        camDot.className = 'status-dot offline';
    }

    // Server status
    document.getElementById('server-status').querySelector('.status-dot').className = 'status-dot online';
}

function updateCameraStatuses() {
    cameras.forEach(cam => {
        const card = document.getElementById(`card-${cam.id}`);
        const recBtn = document.getElementById(`btn-rec-${cam.id}`);
        const recIndicator = document.getElementById(`rec-indicator-${cam.id}`);

        if (card) {
            card.className = `camera-card ${cam.recording ? 'recording' : ''}`;
        }

        if (recBtn) {
            recBtn.className = `cam-btn btn-record ${cam.recording ? 'recording' : ''}`;
            recBtn.innerHTML = cam.recording ? '⏹ STOP REC' : '⏺ RECORD';
        }

        if (recIndicator) {
            recIndicator.className = `camera-rec-indicator ${cam.recording ? 'active' : ''}`;
            if (cam.recording && cam.recordingInfo) {
                const timer = document.getElementById(`rec-timer-${cam.id}`);
                if (timer) {
                    timer.textContent = formatDuration(cam.recordingInfo.duration);
                }
            }
        }
    });
}

// ============== Actions ==============

async function toggleRecording(camId) {
    const cam = cameras.find(c => c.id === camId);
    if (!cam) return;

    try {
        if (cam.recording) {
            const res = await fetch(`${API_BASE}/api/recording/stop/${camId}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(`Recording stopped: ${data.filename}`, 'success');
                fetchRecordingsCount();
            } else {
                showToast(data.message || 'Failed to stop recording', 'error');
            }
        } else {
            const res = await fetch(`${API_BASE}/api/recording/start/${camId}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(`Recording started: ${data.filename}`, 'success');
            } else {
                showToast(data.message || 'Failed to start recording', 'error');
            }
        }
        // Refresh status
        await fetchCameraStatus();
    } catch (err) {
        showToast('Recording action failed', 'error');
    }
}

async function takeScreenshot(camId) {
    try {
        showToast('Capturing screenshot...', 'info');
        const res = await fetch(`${API_BASE}/api/cameras/${camId}/screenshot`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(`Screenshot saved: ${data.filename}`, 'success');
            // Open in new tab
            window.open(`${API_BASE}${data.url}`, '_blank');
        } else {
            showToast('Screenshot failed', 'error');
        }
    } catch (err) {
        showToast('Screenshot failed', 'error');
    }
}

async function restartStream(camId) {
    try {
        showToast('Restarting stream...', 'info');
        await fetch(`${API_BASE}/api/cameras/${camId}/restart`, { method: 'POST' });

        // Destroy and reinit HLS
        if (hlsInstances[camId]) {
            hlsInstances[camId].destroy();
            delete hlsInstances[camId];
        }

        showCameraOffline(camId);

        // Wait for FFmpeg to start generating segments
        setTimeout(() => {
            initHLSStream(camId);
            showToast('Stream restarted', 'success');
        }, 4000);
    } catch (err) {
        showToast('Restart failed', 'error');
    }
}

// ============== Fullscreen ==============

function openFullscreen(camId) {
    const cam = cameras.find(c => c.id === camId);
    if (!cam) return;

    const modal = document.getElementById('fullscreen-modal');
    const video = document.getElementById('fullscreen-video');
    const title = document.getElementById('fullscreen-title');

    title.textContent = cam.name.toUpperCase();

    // Clone stream to fullscreen video
    const hlsUrl = `${API_BASE}/streams/${camId}/stream.m3u8`;
    if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 3 });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => { });
        });
        video._hls = hls;
    }

    modal.classList.add('active');
}

function closeFullscreen() {
    const modal = document.getElementById('fullscreen-modal');
    const video = document.getElementById('fullscreen-video');

    if (video._hls) {
        video._hls.destroy();
        video._hls = null;
    }
    video.src = '';
    modal.classList.remove('active');
}

// ============== Timestamp ==============

function updateTimestamp(camId) {
    const el = document.getElementById(`timestamp-${camId}`);
    if (!el) return;

    function update() {
        const now = new Date();
        el.textContent = now.toLocaleString('en-US', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    }
    update();
    setInterval(update, 1000);
}

// ============== Utilities ==============

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span> ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}
