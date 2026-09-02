let cachedInstances = [];
let statusPoller = null;
let logsInterval = null;
let currentLogs = [];

// ─── Authentication ────────────────────────────────────────────────────────────
function getAuthToken() {
  return localStorage.getItem('dashboard_token');
}

async function checkAuth() {
  const token = getAuthToken();
  if (token) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard-content').classList.remove('hidden');
    switchPage('instances');
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-content').classList.add('hidden');
  }
}

async function performLogin() {
  const user = document.getElementById('login-username').value;
  const pass = document.getElementById('login-password').value;
  const errorBox = document.getElementById('login-error-msg');
  
  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('dashboard_token', data.token);
      errorBox.classList.add('hidden');
      checkAuth();
    } else {
      errorBox.textContent = data.error || 'Login failed';
      errorBox.classList.remove('hidden');
    }
  } catch (err) {
    errorBox.textContent = 'Server error. Please try again.';
    errorBox.classList.remove('hidden');
  }
}

function performLogout() {
  localStorage.removeItem('dashboard_token');
  checkAuth();
}

// ─── API Wrapper ─────────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem('dashboard_token');
    checkAuth();
  }
  return response;
}

// ─── 3 Top-Level Pages Switcher ──────────────────────────────────────────────
function switchPage(page) {
  ['instances', 'send', 'logs'].forEach(p => {
    const view = document.getElementById(`page-${p}`);
    const navBtn = document.getElementById(`nav-btn-${p}`);
    if (view) view.classList.add('hidden');
    if (navBtn) navBtn.classList.remove('active');
  });

  const activeView = document.getElementById(`page-${page}`);
  const activeBtn = document.getElementById(`nav-btn-${page}`);
  if (activeView) activeView.classList.remove('hidden');
  if (activeBtn) activeBtn.classList.add('active');

  if (page === 'instances') {
    loadInstances();
  } else if (page === 'send') {
    loadInstances(false);
  } else if (page === 'logs') {
    loadInstances(false);
    startLogsListener();
  }
}

// ─── Load & Manage Instances ──────────────────────────────────────────────────
async function loadInstances(renderGrid = true) {
  const loading = document.getElementById('instances-loading');
  const empty   = document.getElementById('instances-empty');
  const grid    = document.getElementById('instances-grid');
  const btn     = document.getElementById('refresh-btn');
  const count   = document.getElementById('instances-count-label');

  if (renderGrid) {
    if (loading) loading.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    if (grid) {
      grid.classList.add('hidden');
      grid.innerHTML = '';
    }
    if (btn) btn.classList.add('spinning');
  }

  try {
    const res = await apiFetch('/api/v1/instances');
    const data = await res.json();

    if (renderGrid) {
      if (loading) loading.classList.add('hidden');
      if (btn) btn.classList.remove('spinning');
    }

    if (!res.ok) throw new Error(data.detail || 'Failed to fetch instances');

    // Deduplicate instances by name
    const uniqueMap = new Map();
    (data.data || []).forEach(inst => {
      if (inst && inst.name) {
        const name = inst.name.trim();
        if (!uniqueMap.has(name) || inst.connected) {
          uniqueMap.set(name, inst);
        }
      }
    });

    cachedInstances = Array.from(uniqueMap.values());
    populateDropdowns(cachedInstances);

    if (renderGrid) {
      if (count) {
        count.textContent = `${cachedInstances.length} ${cachedInstances.length === 1 ? 'Instance Available' : 'Instances Available'}`;
      }

      if (cachedInstances.length === 0) {
        if (empty) empty.classList.remove('hidden');
        return;
      }

      if (grid) {
        grid.innerHTML = '';
        grid.classList.remove('hidden');
        cachedInstances.forEach(inst => {
          grid.appendChild(buildInstanceCard(inst));
        });
      }
    }

  } catch (err) {
    if (renderGrid) {
      if (loading) loading.classList.add('hidden');
      if (btn) btn.classList.remove('spinning');
      if (grid) {
        grid.classList.remove('hidden');
        grid.innerHTML = `<div class="alert-box error" style="grid-column: 1 / -1;">${err.message}</div>`;
      }
    }
  }
}

// ─── Custom Stylish Dropdown Controller ──────────────────────────────────────
function toggleDropdown(dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  const menu = dropdown.querySelector('.custom-dropdown-menu');
  const isOpen = dropdown.classList.contains('open');

  // Close all other dropdowns
  document.querySelectorAll('.custom-dropdown').forEach(d => {
    if (d !== dropdown) {
      d.classList.remove('open');
      const m = d.querySelector('.custom-dropdown-menu');
      if (m) m.classList.add('hidden');
    }
  });

  if (isOpen) {
    dropdown.classList.remove('open');
    if (menu) menu.classList.add('hidden');
  } else {
    dropdown.classList.add('open');
    if (menu) menu.classList.remove('hidden');
  }
}

// Global click listener to dismiss dropdowns on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown')) {
    document.querySelectorAll('.custom-dropdown').forEach(d => {
      d.classList.remove('open');
      const m = d.querySelector('.custom-dropdown-menu');
      if (m) m.classList.add('hidden');
    });
  }
});

function selectSendInstance(name) {
  const hiddenInput = document.getElementById('send-instance-select');
  const title = document.getElementById('send-dropdown-title');
  const sub = document.getElementById('send-dropdown-sub');
  const dropdown = document.getElementById('send-instance-dropdown');
  const menu = document.getElementById('send-instance-menu');

  if (hiddenInput) hiddenInput.value = name;

  const found = cachedInstances.find(i => i.name === name);
  if (found) {
    if (title) title.textContent = found.name;
    if (sub) sub.textContent = found.connected ? 'Device Connected & Ready' : 'Device Disconnected';
  } else if (name) {
    if (title) title.textContent = name;
    if (sub) sub.textContent = 'Active Instance';
  }

  // Update selected classes in options
  if (menu) {
    menu.querySelectorAll('.dropdown-option').forEach(opt => {
      if (opt.getAttribute('data-value') === name) {
        opt.classList.add('selected');
        const check = opt.querySelector('.option-check');
        if (check) check.classList.remove('hidden');
      } else {
        opt.classList.remove('selected');
        const check = opt.querySelector('.option-check');
        if (check) check.classList.add('hidden');
      }
    });
  }

  if (dropdown) dropdown.classList.remove('open');
  if (menu) menu.classList.add('hidden');
}

function selectLogsFilter(value) {
  const hiddenInput = document.getElementById('logs-instance-filter');
  const title = document.getElementById('logs-filter-title');
  const dropdown = document.getElementById('logs-filter-dropdown');
  const menu = document.getElementById('logs-filter-menu');

  if (hiddenInput) hiddenInput.value = value;
  if (title) title.textContent = value === 'ALL' ? 'All Instances' : value;

  if (menu) {
    menu.querySelectorAll('.dropdown-option').forEach(opt => {
      if (opt.getAttribute('data-value') === value) {
        opt.classList.add('selected');
        const check = opt.querySelector('.option-check');
        if (check) check.classList.remove('hidden');
      } else {
        opt.classList.remove('selected');
        const check = opt.querySelector('.option-check');
        if (check) check.classList.add('hidden');
      }
    });
  }

  if (dropdown) dropdown.classList.remove('open');
  if (menu) menu.classList.add('hidden');
  renderLogs();
}

function populateDropdowns(instances) {
  // Populate Send Page Custom Dropdown
  const sendMenu = document.getElementById('send-instance-menu');
  const sendHidden = document.getElementById('send-instance-select');
  const currentVal = sendHidden ? sendHidden.value : '';

  if (sendMenu) {
    sendMenu.innerHTML = '';
    if (instances.length === 0) {
      sendMenu.innerHTML = '<div style="padding: 0.75rem 1rem; color: var(--text-3); font-size: 0.85rem; text-align:center;">No instances available</div>';
    } else {
      instances.forEach(inst => {
        const isSelected = inst.name === currentVal;
        const opt = document.createElement('div');
        opt.className = `dropdown-option${isSelected ? ' selected' : ''}`;
        opt.setAttribute('data-value', inst.name);
        opt.onclick = () => selectSendInstance(inst.name);

        opt.innerHTML = `
          <div class="dropdown-option-left">
            <div class="status-tag-dot" style="background: ${inst.connected ? 'var(--accent)' : 'var(--text-3)'}"></div>
            <span class="option-name">${escHtml(inst.name)}</span>
            <span class="status-tag ${inst.connected ? 'linked' : 'unlinked'}" style="font-size: 0.68rem; padding: 0.1rem 0.4rem;">
              ${inst.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <div class="option-check ${isSelected ? '' : 'hidden'}">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
        `;
        sendMenu.appendChild(opt);
      });
    }

    if (!currentVal && instances.length > 0) {
      selectSendInstance(instances[0].name);
    } else if (currentVal) {
      selectSendInstance(currentVal);
    }
  }

  // Populate Logs Filter Custom Dropdown
  const logsMenu = document.getElementById('logs-filter-menu');
  const logsHidden = document.getElementById('logs-instance-filter');
  const currentFilter = logsHidden ? logsHidden.value : 'ALL';

  if (logsMenu) {
    logsMenu.innerHTML = '';

    // "All Instances" option
    const allOpt = document.createElement('div');
    allOpt.className = `dropdown-option${currentFilter === 'ALL' ? ' selected' : ''}`;
    allOpt.setAttribute('data-value', 'ALL');
    allOpt.onclick = () => selectLogsFilter('ALL');
    allOpt.innerHTML = `
      <span class="option-name">All Instances</span>
      <div class="option-check ${currentFilter === 'ALL' ? '' : 'hidden'}">
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
    `;
    logsMenu.appendChild(allOpt);

    instances.forEach(inst => {
      const isSelected = inst.name === currentFilter;
      const opt = document.createElement('div');
      opt.className = `dropdown-option${isSelected ? ' selected' : ''}`;
      opt.setAttribute('data-value', inst.name);
      opt.onclick = () => selectLogsFilter(inst.name);

      opt.innerHTML = `
        <span class="option-name">${escHtml(inst.name)}</span>
        <div class="option-check ${isSelected ? '' : 'hidden'}">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
      `;
      logsMenu.appendChild(opt);
    });
  }
}

function buildInstanceCard(inst) {
  const isLinked = inst.connected && inst.loggedIn;

  const card = document.createElement('div');
  card.className = 'instance-card';
  card.id = `inst-card-${inst.name}`;

  card.innerHTML = `
    <div class="instance-card-header">
      <div class="instance-icon-box">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
      </div>
      <div class="instance-details">
        <div class="instance-title">${escHtml(inst.name)}</div>
        <div style="font-size: 0.8rem; color: #a1a1aa; margin-top: 4px;">API Key: <span style="font-family: monospace; user-select: all; background: #222; padding: 2px 4px; border-radius: 4px;">${escHtml(inst.api_key || 'Not Set')}</span></div>
        <div style="margin-top: 6px;">
          <span class="status-tag ${isLinked ? 'linked' : 'unlinked'}">
            <span class="status-tag-dot"></span>
            ${isLinked ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
    <div class="instance-card-actions">
      <button class="btn-card-action" onclick="quickSendFromCard('${escHtml(inst.name)}')">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        Send Message
      </button>
      <button class="btn-card-delete" title="Delete Instance" onclick="deleteInstance('${escHtml(inst.name)}')">
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>
  `;
  return card;
}

function quickSendFromCard(name) {
  switchPage('send');
  selectSendInstance(name);
}

async function deleteInstance(name) {
  if (!confirm(`Are you sure you want to delete "${name}"? This will disconnect WhatsApp from the server.`)) return;
  try {
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error("Failed to delete instance");
    loadInstances();
  } catch (err) {
    alert(err.message);
  }
}

// ─── Modal Management ────────────────────────────────────────────────────────
function openConnectModal() {
  const modal = document.getElementById('connect-modal');
  resetModalToStep1();
  if (modal) modal.classList.remove('hidden');
  const input = document.getElementById('instance-name');
  if (input) input.focus();
}

function closeConnectModal() {
  const modal = document.getElementById('connect-modal');
  if (modal) modal.classList.add('hidden');
  stopPolling();
}

function resetModalToStep1() {
  stopPolling();
  const stepName = document.getElementById('modal-step-name');
  const stepQr   = document.getElementById('modal-step-qr');
  const errorMsg = document.getElementById('error-msg');
  const connectBtn = document.getElementById('connect-btn');

  if (stepName) stepName.classList.remove('hidden');
  if (stepQr) stepQr.classList.add('hidden');
  if (errorMsg) {
    errorMsg.classList.add('hidden');
    errorMsg.textContent = '';
  }
  if (connectBtn) {
    connectBtn.disabled = false;
    connectBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Generate QR Code`;
  }
}

// ─── Connect Instance (QR Lifecycle) ─────────────────────────────────────────
async function connectInstance() {
  const nameInput  = document.getElementById('instance-name');
  const name       = nameInput ? nameInput.value.trim() : '';
  const apiKeyInput = document.getElementById('instance-api-key');
  const apiKey     = apiKeyInput ? apiKeyInput.value.trim() : '';
  const errorMsg   = document.getElementById('error-msg');
  const stepName   = document.getElementById('modal-step-name');
  const stepQr     = document.getElementById('modal-step-qr');
  const qrNameLabel = document.getElementById('qr-modal-instance-name');
  const qrLoader   = document.getElementById('qr-loader');
  const qrResult   = document.getElementById('qr-result');
  const qrImage    = document.getElementById('qr-image');

  if (errorMsg) {
    errorMsg.className = 'alert-box error hidden';
    errorMsg.textContent = '';
  }
  stopPolling();

  if (!name || !apiKey) {
    if (errorMsg) {
      errorMsg.textContent = 'Please specify both an instance name and an API key to proceed.';
      errorMsg.classList.remove('hidden');
    }
    return;
  }

  // Switch to Step 2
  if (stepName) stepName.classList.add('hidden');
  if (stepQr) stepQr.classList.remove('hidden');
  if (qrNameLabel) qrNameLabel.textContent = name;
  if (qrLoader) qrLoader.classList.remove('hidden');
  if (qrResult) qrResult.classList.add('hidden');

  try {
    const status = await checkStatus(name);
    if (status.connected) {
      onDeviceLinked(name);
      return;
    }

    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to create instance.');

    const qrBase64 = result.data?.qrcode;

    if (qrLoader) qrLoader.classList.add('hidden');
    if (qrResult) qrResult.classList.remove('hidden');

    if (qrBase64 && qrImage) {
      qrImage.src = qrBase64;
      qrImage.style.display = 'block';
      startStatusPolling(name);
    } else {
      resetModalToStep1();
      if (errorMsg) {
        errorMsg.textContent = 'Could not generate QR. Please try a different name or verify server logs.';
        errorMsg.classList.remove('hidden');
      }
    }

  } catch (err) {
    resetModalToStep1();
    if (errorMsg) {
      errorMsg.textContent = err.message;
      errorMsg.classList.remove('hidden');
    }
  }
}

// ─── Status Polling ───────────────────────────────────────────────────────────
async function checkStatus(instanceName) {
  try {
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(instanceName)}/status`);
    const result = await res.json();
    return result.data || { status: 'DISCONNECTED' };
  } catch {
    return { status: 'DISCONNECTED' };
  }
}

function startStatusPolling(name) {
  stopPolling();
  statusPoller = setInterval(async () => {
    const status = await checkStatus(name);
    if (status.status === 'CONNECTED') {
      stopPolling();
      onDeviceLinked(name);
    }
  }, 4000);
}

function stopPolling() {
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }
}

function onDeviceLinked(name) {
  closeConnectModal();
  switchPage('send');
  selectSendInstance(name);

  const s = document.getElementById('send-status');
  if (s) {
    s.textContent = `Instance "${name}" connected successfully. Ready to send messages.`;
    s.className = 'alert-box success';
    s.classList.remove('hidden');
  }
}

function proceedToSend() {
  const nameInput = document.getElementById('instance-name');
  const name = nameInput ? nameInput.value.trim() : '';
  stopPolling();
  closeConnectModal();
  switchPage('send');
  if (name) {
    selectSendInstance(name);
  }
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendMessage() {
  const instanceSelect = document.getElementById('send-instance-select');
  const phoneInput     = document.getElementById('phone-number');
  const msgInput       = document.getElementById('message-text');
  const sendBtn        = document.getElementById('send-btn');
  const sendStatus     = document.getElementById('send-status');

  const instance = instanceSelect ? instanceSelect.value : '';
  const rawNumber = phoneInput ? phoneInput.value.trim() : '';
  const text      = msgInput ? msgInput.value.trim() : '';

  if (sendStatus) sendStatus.className = 'alert-box hidden';

  if (!instance) {
    if (sendStatus) {
      sendStatus.textContent = 'Please select a WhatsApp instance from the dropdown.';
      sendStatus.className = 'alert-box error';
      sendStatus.classList.remove('hidden');
    }
    return;
  }
  if (!rawNumber || !text) {
    if (sendStatus) {
      sendStatus.textContent = 'Please enter both the recipient number and message content.';
      sendStatus.className = 'alert-box error';
      sendStatus.classList.remove('hidden');
    }
    return;
  }

  const digits = rawNumber.replace(/\D/g, '');
  const number = digits.startsWith('91') && digits.length > 10 ? digits : `91${digits}`;

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = `<div class="spinner-ring" style="width:16px;height:16px;border-width:2px;margin:0"></div> Sending...`;
  }

  try {
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(instance)}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: number, message: text })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to dispatch message.');

    if (sendStatus) {
      sendStatus.textContent = 'Message dispatched successfully.';
      sendStatus.className = 'alert-box success';
    }
    if (msgInput) msgInput.value = '';

  } catch (err) {
    if (sendStatus) {
      sendStatus.textContent = err.message;
      sendStatus.className = 'alert-box error';
    }
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send WhatsApp Message`;
    }
    if (sendStatus) sendStatus.classList.remove('hidden');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Local API Logs Stream ───────────────────────────────────────────────────
function startLogsListener() {
  if (logsInterval) clearInterval(logsInterval);

  const fetchLogs = async () => {
    try {
      const res = await apiFetch('/api/v1/messages/logs');
      const result = await res.json();
      if (res.ok && result.success) {
        currentLogs = result.data || [];
        renderLogs();
      }
    } catch (err) {
      const tbody = document.getElementById("logs-tbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="padding: 2rem; text-align: center; color: var(--red);">Failed to fetch logs: ${err.message}</td></tr>`;
    }
  };

  fetchLogs(); // Initial fetch
  logsInterval = setInterval(fetchLogs, 3000); // Poll every 3 seconds
}

function filterLogs() {
  renderLogs();
}

function renderLogs() {
  const tbody = document.getElementById("logs-tbody");
  const filterSelect = document.getElementById("logs-instance-filter");
  const selectedFilter = filterSelect ? filterSelect.value : "ALL";

  if (!tbody) return;
  tbody.innerHTML = "";

  const filtered = currentLogs.filter(data => {
    if (selectedFilter === "ALL") return true;
    return data.instanceName === selectedFilter;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="table-empty-row">No message logs recorded for this view.</td></tr>`;
    return;
  }

  filtered.forEach(data => {
    const tr = document.createElement("tr");
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "-";
    
    let dispNumber = data.number || '-';
    if (dispNumber.startsWith("91") && dispNumber.length > 10) {
      dispNumber = dispNumber.substring(2);
    }

    tr.innerHTML = `
      <td style="color:var(--text-2); font-size:0.88rem">${time}</td>
      <td style="font-weight: 600; color: var(--accent);">${escHtml(data.instanceName || '-')}</td>
      <td style="font-family: monospace; font-weight: 600">${escHtml(dispNumber)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Application Bootstrap ────────────────────────────────────────────────────
checkAuth();
