// ============================================
// AI HOME CAMERA — Dashboard App
// ============================================

const API_BASE = window.location.origin;
let cameras = [];
let hlsInstances = {};
let pollInterval = null;
let activeFullscreenCamId = null;
let fullscreenTransitioning = false;
const uiSounds = {
    click: null,
    expand: null
};

// ============== Init ==============

document.addEventListener('DOMContentLoaded', () => {
    initUiSounds();
    attachUiClickSounds();
    startClock();
    fetchCameras();
    pollInterval = setInterval(fetchCameraStatus, 5000);
    fetchRecordingsCount();

    // Fullscreen modal close
    document.getElementById('btn-close-fullscreen').addEventListener('click', closeFullscreen);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeFullscreen();

        // Keyboard PTZ in fullscreen
        const modalActive = document.getElementById('fullscreen-modal')?.classList.contains('active');
        if (!modalActive) return;

        if (e.key === 'ArrowUp') fullscreenPtzMove('up');
        if (e.key === 'ArrowDown') fullscreenPtzMove('down');
        if (e.key === 'ArrowLeft') fullscreenPtzMove('left');
        if (e.key === 'ArrowRight') fullscreenPtzMove('right');
        if (e.key === ' ') fullscreenPtzStop();
    });
});

function initUiSounds() {
    uiSounds.click = new Audio('sounds/ui-click.wav');
    uiSounds.expand = new Audio('sounds/ui-expand.wav');

    Object.values(uiSounds).forEach((audio) => {
        audio.preload = 'auto';
        audio.volume = 0.35;
    });
}

function playUiSound(type = 'click') {
    const source = uiSounds[type] || uiSounds.click;
    if (!source) return;

    // Clone enables rapid repeated clicks without clipping.
    const shot = source.cloneNode();
    shot.volume = source.volume;
    shot.play().catch(() => { });
}

function attachUiClickSounds() {
    document.addEventListener('click', (event) => {
        const interactive = event.target.closest('.cam-btn, .ptz-btn, .nav-link, .btn-close-fullscreen, .cyber-btn, .rec-action-btn');
        if (!interactive) return;
        if (interactive.classList.contains('btn-fullscreen')) return; // handled with expand sound
        playUiSound('click');
    });
}

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
      <div class="camera-controls camera-controls-secondary">
        <button class="cam-btn btn-quality" id="btn-quality-${cam.id}" onclick="toggleQuality('${cam.id}')">
          ${cam.qualityMode === 'sd' ? 'SD MODE' : 'HD MODE'}
        </button>
        <button class="cam-btn btn-motion ${cam.motionEnabled ? 'active' : ''}" id="btn-motion-${cam.id}" onclick="toggleMotion('${cam.id}')">
          ${cam.motionEnabled ? 'MOTION ON' : 'MOTION OFF'}
        </button>
      </div>
      ${renderPtzControls(cam)}
    `;
        grid.appendChild(card);

        // Initialize HLS stream
        initHLSStream(cam.id);

        // Start timestamp
        updateTimestamp(cam.id);
    });
}

function renderPtzControls(cam) {
    if (!cam.ptzEnabled) return '';

    return `
      <div class="camera-ptz">
        <div class="ptz-title">PTZ CONTROL</div>
        <div class="ptz-grid">
          <button class="ptz-btn" onclick="ptzMove('${cam.id}', 'up')" title="Move Up">▲</button>
          <button class="ptz-btn" onclick="ptzMove('${cam.id}', 'left')" title="Move Left">◀</button>
          <button class="ptz-btn ptz-stop" onclick="ptzStop('${cam.id}')" title="Stop">■</button>
          <button class="ptz-btn" onclick="ptzMove('${cam.id}', 'right')" title="Move Right">▶</button>
          <button class="ptz-btn" onclick="ptzMove('${cam.id}', 'down')" title="Move Down">▼</button>
        </div>
      </div>
    `;
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
        const qualityBtn = document.getElementById(`btn-quality-${cam.id}`);
        const motionBtn = document.getElementById(`btn-motion-${cam.id}`);

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

        if (qualityBtn) {
            qualityBtn.innerHTML = cam.qualityMode === 'sd' ? 'SD MODE' : 'HD MODE';
        }

        if (motionBtn) {
            motionBtn.className = `cam-btn btn-motion ${cam.motionEnabled ? 'active' : ''}`;
            motionBtn.innerHTML = cam.motionEnabled ? 'MOTION ON' : 'MOTION OFF';
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

async function toggleQuality(camId) {
    const cam = cameras.find(c => c.id === camId);
    if (!cam) return;
    const nextMode = cam.qualityMode === 'sd' ? 'hd' : 'sd';

    try {
        showToast(`Switching to ${nextMode.toUpperCase()}...`, 'info');
        const res = await fetch(`${API_BASE}/api/cameras/${camId}/quality`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: nextMode })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Quality change failed');
        }
        await fetchCameraStatus();
        showToast(`Quality set to ${nextMode.toUpperCase()}`, 'success');
    } catch (err) {
        showToast(`Quality failed: ${err.message}`, 'error');
    }
}

async function toggleMotion(camId) {
    const cam = cameras.find(c => c.id === camId);
    if (!cam) return;
    const nextEnabled = !cam.motionEnabled;
    try {
        const res = await fetch(`${API_BASE}/api/cameras/${camId}/motion`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextEnabled })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Motion toggle failed');
        }
        await fetchCameraStatus();
        showToast(`Motion ${nextEnabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
        showToast(`Motion failed: ${err.message}`, 'error');
    }
}

async function ptzMove(camId, direction) {
    try {
        const res = await fetch(`${API_BASE}/api/cameras/${camId}/ptz/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'PTZ move failed');
        }
        showToast(`PTZ ${direction.toUpperCase()}`, 'info');
    } catch (err) {
        showToast(`PTZ failed: ${err.message}`, 'error');
    }
}

async function ptzStop(camId) {
    try {
        const res = await fetch(`${API_BASE}/api/cameras/${camId}/ptz/stop`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'PTZ stop failed');
        }
        showToast('PTZ STOP', 'info');
    } catch (err) {
        showToast(`PTZ stop failed: ${err.message}`, 'error');
    }
}

// ============== Fullscreen ==============

function openFullscreen(camId) {
    if (fullscreenTransitioning) return;

    const cam = cameras.find(c => c.id === camId);
    if (!cam) return;
    playUiSound('expand');

    const modal = document.getElementById('fullscreen-modal');
    const shell = document.getElementById('fullscreen-video-shell');
    const video = document.getElementById('fullscreen-video');
    const title = document.getElementById('fullscreen-title');
    const source = document.getElementById(`video-container-${camId}`);

    title.textContent = cam.name.toUpperCase();
    activeFullscreenCamId = camId;
    updateFullscreenPtzControls(cam);

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

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!source || prefersReducedMotion) return;

    fullscreenTransitioning = true;
    shell.classList.add('video-shell-animating');

    const sourceRect = source.getBoundingClientRect();
    const targetRect = shell.getBoundingClientRect();

    const sourceCenterX = sourceRect.left + sourceRect.width / 2;
    const sourceCenterY = sourceRect.top + sourceRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;

    const translateX = sourceCenterX - targetCenterX;
    const translateY = sourceCenterY - targetCenterY;
    const scaleX = sourceRect.width / targetRect.width;
    const scaleY = sourceRect.height / targetRect.height;

    shell.style.transition = 'none';
    shell.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
    shell.style.borderRadius = '6px';
    shell.style.boxShadow = '0 0 25px rgba(0, 240, 255, 0.25)';

    requestAnimationFrame(() => {
        shell.style.transition = 'transform 520ms cubic-bezier(0.2, 0.85, 0.2, 1), border-radius 520ms cubic-bezier(0.2, 0.85, 0.2, 1), box-shadow 520ms ease';
        shell.style.transform = 'translate(0px, 0px) scale(1, 1)';
        shell.style.borderRadius = '0px';
        shell.style.boxShadow = '0 0 80px rgba(0, 240, 255, 0.12)';
    });

    setTimeout(() => {
        shell.classList.remove('video-shell-animating');
        shell.style.transition = '';
        shell.style.transform = '';
        shell.style.borderRadius = '';
        shell.style.boxShadow = '';
        fullscreenTransitioning = false;
    }, 560);
}

function closeFullscreen() {
    if (fullscreenTransitioning) return;

    const modal = document.getElementById('fullscreen-modal');
    const shell = document.getElementById('fullscreen-video-shell');
    const video = document.getElementById('fullscreen-video');
    const source = activeFullscreenCamId ? document.getElementById(`video-container-${activeFullscreenCamId}`) : null;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const cleanupAndClose = () => {
        if (video._hls) {
            video._hls.destroy();
            video._hls = null;
        }
        video.src = '';
        modal.classList.remove('active');
        activeFullscreenCamId = null;
        updateFullscreenPtzControls(null);
    };

    if (!source || prefersReducedMotion) {
        cleanupAndClose();
        return;
    }

    fullscreenTransitioning = true;
    shell.classList.add('video-shell-animating');

    const sourceRect = source.getBoundingClientRect();
    const targetRect = shell.getBoundingClientRect();

    const sourceCenterX = sourceRect.left + sourceRect.width / 2;
    const sourceCenterY = sourceRect.top + sourceRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;

    const translateX = sourceCenterX - targetCenterX;
    const translateY = sourceCenterY - targetCenterY;
    const scaleX = sourceRect.width / targetRect.width;
    const scaleY = sourceRect.height / targetRect.height;

    shell.style.transition = 'transform 420ms cubic-bezier(0.4, 0, 0.2, 1), border-radius 420ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 420ms ease';
    shell.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
    shell.style.borderRadius = '6px';
    shell.style.boxShadow = '0 0 25px rgba(0, 240, 255, 0.25)';

    modal.style.opacity = '0';

    setTimeout(() => {
        modal.style.opacity = '';
        shell.classList.remove('video-shell-animating');
        shell.style.transition = '';
        shell.style.transform = '';
        shell.style.borderRadius = '';
        shell.style.boxShadow = '';
        cleanupAndClose();
        fullscreenTransitioning = false;
    }, 430);
}

function updateFullscreenPtzControls(cam) {
    const ptzPanel = document.getElementById('fullscreen-ptz');
    if (!ptzPanel) return;

    if (cam && cam.ptzEnabled) {
        ptzPanel.classList.remove('hidden');
    } else {
        ptzPanel.classList.add('hidden');
    }
}

function fullscreenPtzMove(direction) {
    if (!activeFullscreenCamId) return;
    ptzMove(activeFullscreenCamId, direction);
}

function fullscreenPtzStop() {
    if (!activeFullscreenCamId) return;
    ptzStop(activeFullscreenCamId);
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
