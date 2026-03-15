// ============================================
// AI HOME CAMERA — Recordings Page
// ============================================

const API_BASE = window.location.origin;
let allRecordings = [];
let deleteTarget = null;
const uiSounds = {
    click: null,
    expand: null
};

// ============== Init ==============

document.addEventListener('DOMContentLoaded', () => {
    initUiSounds();
    attachUiClickSounds();
    wireLogoutButton();
    startClock();
    fetchRecordings();

    document.getElementById('btn-refresh').addEventListener('click', fetchRecordings);
    document.getElementById('filter-camera').addEventListener('change', renderRecordings);
    document.getElementById('filter-sort').addEventListener('change', renderRecordings);

    // Playback modal
    document.getElementById('btn-close-playback').addEventListener('click', closePlayback);

    // Delete confirmation
    document.getElementById('btn-cancel-delete').addEventListener('click', closeDeleteConfirm);
    document.getElementById('btn-confirm-delete').addEventListener('click', confirmDelete);

    // ESC to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePlayback();
            closeDeleteConfirm();
        }
    });

    // Populate camera filter
    populateCameraFilter();
    ensureAuthenticated();
});

async function ensureAuthenticated() {
    try {
        const res = await fetch(`${API_BASE}/api/auth/me`);
        if (!res.ok) {
            window.location.href = '/login.html';
        }
    } catch {
        window.location.href = '/login.html';
    }
}

function wireLogoutButton() {
    const btn = document.getElementById('btn-logout');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        try {
            await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
        } catch (err) {
            // ignore
        }
        window.location.href = '/login.html';
    });
}

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

    const shot = source.cloneNode();
    shot.volume = source.volume;
    shot.play().catch(() => { });
}

function attachUiClickSounds() {
    document.addEventListener('click', (event) => {
        const interactive = event.target.closest('.cyber-btn, .rec-action-btn, .nav-link, .btn-close-playback, .btn-cancel, .btn-danger, .recording-item, .btn-logout');
        if (!interactive) return;
        if (interactive.classList.contains('recording-item')) {
            playUiSound('expand');
            return;
        }
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

// ============== Fetch Data ==============

async function populateCameraFilter() {
    try {
        const res = await fetch(`${API_BASE}/api/cameras`);
        const cameras = await res.json();
        const select = document.getElementById('filter-camera');
        cameras.forEach(cam => {
            const opt = document.createElement('option');
            opt.value = cam.id;
            opt.textContent = cam.name.toUpperCase();
            select.appendChild(opt);
        });
    } catch (err) {
        console.error('Failed to fetch cameras:', err);
    }
}

async function fetchRecordings() {
    const list = document.getElementById('recordings-list');
    const emptyState = document.getElementById('empty-state');

    list.innerHTML = `
    <div class="loading-state">
      <div class="cyber-spinner"></div>
      <p>SCANNING ARCHIVE...</p>
    </div>
  `;
    emptyState.classList.add('hidden');

    try {
        const res = await fetch(`${API_BASE}/api/recordings`);
        allRecordings = await res.json();
        renderRecordings();
    } catch (err) {
        list.innerHTML = '';
        showToast('Failed to load recordings', 'error');
    }
}

// ============== Render ==============

function renderRecordings() {
    const list = document.getElementById('recordings-list');
    const emptyState = document.getElementById('empty-state');

    const cameraFilter = document.getElementById('filter-camera').value;
    const sortBy = document.getElementById('filter-sort').value;

    // Filter
    let filtered = allRecordings.filter(r => {
        if (cameraFilter !== 'all' && r.cameraId !== cameraFilter) return false;
        return true;
    });

    // Sort
    switch (sortBy) {
        case 'newest':
            filtered.sort((a, b) => new Date(b.created) - new Date(a.created));
            break;
        case 'oldest':
            filtered.sort((a, b) => new Date(a.created) - new Date(b.created));
            break;
        case 'largest':
            filtered.sort((a, b) => b.size - a.size);
            break;
    }

    list.innerHTML = '';

    if (filtered.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    filtered.forEach(rec => {
        const item = document.createElement('div');
        item.className = 'recording-item';
        item.onclick = (e) => {
            // Don't open playback if clicking action buttons
            if (e.target.closest('.recording-actions')) return;
            openPlayback(rec);
        };

        const date = new Date(rec.created);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour12: false });

        item.innerHTML = `
      <div class="recording-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <div class="recording-details">
        <span class="recording-filename">${rec.filename}</span>
        <span class="recording-meta">
          <span>📅 ${dateStr}</span>
          <span>🕒 ${timeStr}</span>
        </span>
      </div>
      <span class="recording-camera-badge ${rec.cameraId}">${rec.cameraName || rec.cameraId}</span>
      <span class="recording-size">${rec.sizeFormatted}</span>
      <div class="recording-actions">
        <a class="rec-action-btn" href="${rec.url}" download title="Download">
          ⬇ DL
        </a>
        <button class="rec-action-btn btn-delete" onclick="openDeleteConfirm('${rec.filename}')" title="Delete">
          🗑 DEL
        </button>
      </div>
    `;

        list.appendChild(item);
    });
}

// ============== Playback ==============

function openPlayback(rec) {
    const modal = document.getElementById('playback-modal');
    const video = document.getElementById('playback-video');
    const title = document.getElementById('playback-title');
    const info = document.getElementById('playback-info');

    title.textContent = rec.filename;
    video.src = `${API_BASE}${rec.url}`;

    const date = new Date(rec.created);
    info.textContent = `Camera: ${rec.cameraName || rec.cameraId} • Size: ${rec.sizeFormatted} • Recorded: ${date.toLocaleString()}`;

    modal.classList.add('active');
}

function closePlayback() {
    const modal = document.getElementById('playback-modal');
    const video = document.getElementById('playback-video');

    video.pause();
    video.src = '';
    modal.classList.remove('active');
}

// ============== Delete ==============

function openDeleteConfirm(filename) {
    deleteTarget = filename;
    document.getElementById('confirm-filename').textContent = filename;
    document.getElementById('confirm-modal').classList.add('active');
}

function closeDeleteConfirm() {
    deleteTarget = null;
    document.getElementById('confirm-modal').classList.remove('active');
}

async function confirmDelete() {
    if (!deleteTarget) return;

    try {
        const res = await fetch(`${API_BASE}/api/recordings/${deleteTarget}`, { method: 'DELETE' });
        const data = await res.json();

        if (data.success) {
            showToast(`Deleted: ${deleteTarget}`, 'success');
            closeDeleteConfirm();
            fetchRecordings();
        } else {
            showToast('Delete failed', 'error');
        }
    } catch (err) {
        showToast('Delete failed', 'error');
    }
}

// ============== Toast ==============

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
