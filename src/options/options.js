import Storage from '../lib/storage.js';
import SilentSendCrypto from '../lib/crypto.js';
import SilentSendSync from '../lib/sync.js';
import api from '../lib/browser-polyfill.js';

let mappings = [];
let settings = {};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  settings = await Storage.getSettings();

  // Apply settings to UI
  $('#showHighlights').checked = settings.showHighlights || false;
  $('#secretScanning').checked = settings.secretScanning !== false;
  $('#autoDetect').checked = settings.autoDetect !== false;
  $('#autoRedactDetected').checked = settings.autoRedactDetected !== false;
  $('#autoAddDetected').checked = settings.autoAddDetected !== false;
  $('#maxLogEntries').value = settings.maxLogEntries || 200;
  $('#browserSync').checked = settings.browserSync === true;

  renderMappings();
  renderDomains();
  renderLog();

  // --- Sync section ---
  $('#browserSync').addEventListener('change', async (e) => {
    await Storage.saveSettings({ browserSync: e.target.checked });
    if (e.target.checked) {
      await SilentSendSync.pushToSyncStorage();
      setSyncStatus('Browser account sync enabled. Your settings will sync automatically.', 'ok');
    } else {
      setSyncStatus('Browser account sync disabled.', 'neutral');
    }
  });

  $('#btnGenerateSyncCode').addEventListener('click', async () => {
    const code = await SilentSendSync.exportSyncCode();
    const data = await SilentSendSync._getAllData();
    $('#syncCodeText').value = code;
    $('#syncCodeDisplay').style.display = 'block';
    $('#syncImportSection').style.display = 'none';
    $('#syncCodeTime').textContent = 'Generated: ' + new Date(data.lastModified).toLocaleString();
    setSyncStatus('', 'neutral');
  });

  $('#btnCopySyncCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#syncCodeText').value);
      $('#btnCopySyncCode').textContent = 'Copied!';
      setTimeout(() => { $('#btnCopySyncCode').textContent = 'Copy to Clipboard'; }, 2000);
    } catch {
      $('#syncCodeText').select();
      document.execCommand('copy');
    }
  });

  $('#btnImportSyncCode').addEventListener('click', () => {
    $('#syncImportSection').style.display = 'block';
    $('#syncCodeDisplay').style.display = 'none';
    $('#syncImportText').focus();
    setSyncStatus('', 'neutral');
  });

  $('#btnApplySyncCode').addEventListener('click', async () => {
    const code = $('#syncImportText').value.trim();
    if (!code) return;
    const force = $('#syncForce').checked;
    const result = await SilentSendSync.importSyncCode(code, { force });
    if (result.success) {
      setSyncStatus(`Imported successfully (data from ${result.importTime}).`, 'ok');
      $('#syncImportSection').style.display = 'none';
      $('#syncImportText').value = '';
      mappings = await Storage.getMappings();
      settings = await Storage.getSettings();
      $('#browserSync').checked = settings.browserSync === true;
      renderMappings();
      renderDomains();
      renderLog();
    } else if (result.skipped) {
      setSyncStatus(
        `Skipped: local data is newer (local: ${result.localTime} vs import: ${result.importTime}). Check "Force" to override.`,
        'warn'
      );
    } else {
      setSyncStatus(`Failed: ${result.reason}`, 'error');
    }
  });

  $('#btnCancelSyncImport').addEventListener('click', () => {
    $('#syncImportSection').style.display = 'none';
    $('#syncImportText').value = '';
    setSyncStatus('', 'neutral');
  });

  // --- File-based auto-sync ---
  await initFileSync();

  $('#btnPickSyncFolder').addEventListener('click', pickSyncFolder);
  $('#btnClearSyncFolder').addEventListener('click', async () => {
    await SilentSendSync.clearSyncDirHandle();
    syncDirHandle = null;
    updateFileSyncUI();
    setFileSyncStatus('Sync folder cleared.', 'neutral');
  });

  // Auto-write when local storage changes (catches popup edits, page-world adds, etc.)
  api.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && (changes.ss_settings || changes.ss_mappings || changes.ss_identity)) {
      await writeToSyncFile();
    }
  });

  // Re-check sync file whenever the options page regains focus
  window.addEventListener('focus', async () => {
    await checkFileSyncUpdate();
  });

  // Transfer data
  $('#btnExportAll').addEventListener('click', exportAllPlain);
  $('#btnExportEncrypted').addEventListener('click', exportAllEncrypted);
  $('#btnImportAll').addEventListener('click', () => $('#fileImportAll').click());
  $('#fileImportAll').addEventListener('change', importAll);

  // Custom domains
  $('#btnAddDomain').addEventListener('click', addDomain);
  $('#newDomain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addDomain();
  });

  // Settings listeners
  $('#showHighlights').addEventListener('change', async (e) => {
    await Storage.saveSettings({ showHighlights: e.target.checked });
  });

  $('#secretScanning').addEventListener('change', async (e) => {
    await Storage.saveSettings({ secretScanning: e.target.checked });
  });

  $('#autoDetect').addEventListener('change', async (e) => {
    await Storage.saveSettings({ autoDetect: e.target.checked });
  });

  $('#autoRedactDetected').addEventListener('change', async (e) => {
    await Storage.saveSettings({ autoRedactDetected: e.target.checked });
  });

  $('#autoAddDetected').addEventListener('change', async (e) => {
    await Storage.saveSettings({ autoAddDetected: e.target.checked });
  });

  $('#maxLogEntries').addEventListener('change', async (e) => {
    await Storage.saveSettings({ maxLogEntries: parseInt(e.target.value, 10) || 200 });
  });

  // Add mapping
  $('#btnAddMapping').addEventListener('click', addMapping);
  $('#newSub').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addMapping();
  });

  // Export
  $('#btnExport').addEventListener('click', () => {
    const data = JSON.stringify(mappings, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'silent-send-mappings.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Import
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Expected array');
      // Merge: add IDs if missing
      for (const item of imported) {
        if (!item.id) item.id = crypto.randomUUID();
        if (!item.createdAt) item.createdAt = Date.now();
        if (item.enabled === undefined) item.enabled = true;
      }
      mappings = [...mappings, ...imported];
      await Storage.saveMappings(mappings);
      renderMappings();
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
  });

  // Clear all
  $('#btnClearAll').addEventListener('click', async () => {
    if (!confirm('Delete all mappings? This cannot be undone.')) return;
    mappings = [];
    await Storage.saveMappings([]);
    renderMappings();
  });

  // Clear log
  $('#btnClearLog').addEventListener('click', async () => {
    await Storage.clearLog();
    renderLog();
  });

  // Reset all data
  $('#btnResetAll').addEventListener('click', async () => {
    if (!confirm('This will delete ALL your identities, mappings, settings, and logs.\n\nAre you sure?')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    await api.storage.local.clear();
    mappings = [];
    settings = {};
    renderMappings();
    renderDomains();
    renderLog();
    alert('All data cleared. Reload the extension to start fresh.');
  });
});

async function addMapping() {
  const real = $('#newReal').value.trim();
  const sub = $('#newSub').value.trim();
  if (!real || !sub) return;

  const mapping = await Storage.addMapping({
    real,
    substitute: sub,
    category: $('#newCategory').value,
    caseSensitive: $('#newCaseSensitive').checked,
  });

  mappings.push(mapping);
  renderMappings();

  $('#newReal').value = '';
  $('#newSub').value = '';
  $('#newCaseSensitive').checked = false;
  $('#newReal').focus();
}

function renderMappings() {
  const tbody = $('#mappingTableBody');

  if (mappings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">No mappings configured</td></tr>';
    return;
  }

  tbody.innerHTML = mappings
    .map(
      (m) => `
    <tr data-id="${m.id}">
      <td class="real">${escapeHtml(m.real)}</td>
      <td class="sub">${escapeHtml(m.substitute)}</td>
      <td><span class="cat">${m.category || 'general'}</span></td>
      <td>${m.caseSensitive ? 'Yes' : 'No'}</td>
      <td>
        <label class="toggle" style="width:32px;height:18px">
          <input type="checkbox" class="toggle-enabled" ${m.enabled ? 'checked' : ''}>
          <span class="toggle-slider" style="border-radius:18px"></span>
        </label>
      </td>
      <td><button class="btn btn-sm btn-danger btn-delete">&times;</button></td>
    </tr>
  `
    )
    .join('');

  // Bind
  tbody.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      await Storage.deleteMapping(id);
      mappings = mappings.filter((m) => m.id !== id);
      renderMappings();
    });
  });

  tbody.querySelectorAll('.toggle-enabled').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.closest('tr').dataset.id;
      await Storage.updateMapping(id, { enabled: cb.checked });
      const m = mappings.find((m) => m.id === id);
      if (m) m.enabled = cb.checked;
    });
  });
}

async function renderLog() {
  const log = await Storage.getLog();
  $('#logCount').textContent = `${log.length} entries`;

  const list = $('#logList');
  if (log.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:24px">No activity logged</div>';
    return;
  }

  list.innerHTML = log
    .slice(0, 100)
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString();
      return `
      <div class="log-item">
        <span class="log-time">${time}</span>
        <span class="log-original">${escapeHtml(entry.original || '')}</span>
        <span>&rarr;</span>
        <span class="log-replaced">${escapeHtml(entry.replaced || '')}</span>
      </div>
    `;
    })
    .join('');
}

// --- Custom Domains ---
async function addDomain() {
  let domain = $('#newDomain').value.trim();
  if (!domain) return;

  // Normalize: ensure it has a protocol
  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = 'https://' + domain;
  }
  // Strip trailing slashes
  domain = domain.replace(/\/+$/, '');

  const domains = settings.customDomains || [];
  if (domains.includes(domain)) {
    alert('Domain already added.');
    return;
  }

  // Request browser permission for this domain
  try {
    const granted = await api.permissions.request({
      origins: [domain + '/*'],
    });
    if (!granted) {
      alert('Permission denied. The extension needs access to this domain to work.');
      return;
    }
  } catch (e) {
    // Firefox or older Chrome may not support optional permissions this way
    console.warn('[Silent Send] Could not request permission:', e);
  }

  domains.push(domain);
  settings.customDomains = domains;
  await Storage.saveSettings({ customDomains: domains });
  renderDomains();
  $('#newDomain').value = '';
}

function renderDomains() {
  const list = $('#domainList');
  const domains = settings.customDomains || [];

  if (domains.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:12px;font-size:13px">No custom domains. Built-in sites (Claude, ChatGPT, Grok, Gemini, localhost) are always active.</div>';
    return;
  }

  list.innerHTML = domains
    .map((d, i) => `
      <div class="domain-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:#f9fafb;border-radius:6px;margin-bottom:4px">
        <span style="font-size:13px;font-family:monospace">${escapeHtml(d)}</span>
        <button class="btn btn-sm btn-danger btn-remove-domain" data-index="${i}">&times;</button>
      </div>
    `)
    .join('');

  list.querySelectorAll('.btn-remove-domain').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const domains = settings.customDomains || [];
      domains.splice(idx, 1);
      settings.customDomains = domains;
      await Storage.saveSettings({ customDomains: domains });
      renderDomains();
    });
  });
}

// --- Transfer Data (Export/Import All) ---

async function getAllData() {
  const result = await api.storage.local.get(null); // get everything
  return {
    version: '1',
    exportedAt: new Date().toISOString(),
    identity: result.ss_identity || {},
    mappings: result.ss_mappings || [],
    settings: result.ss_settings || {},
  };
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAllPlain() {
  const data = await getAllData();
  downloadFile(JSON.stringify(data, null, 2), 'silent-send-backup.json');
}

async function exportAllEncrypted() {
  const password = prompt('Set a password for this backup:');
  if (!password) return;
  const confirm = prompt('Confirm password:');
  if (password !== confirm) {
    alert('Passwords do not match.');
    return;
  }

  const data = await getAllData();
  try {
    const encrypted = await SilentSendCrypto.encrypt(data, password);
    const wrapper = JSON.stringify({ encrypted: true, data: encrypted });
    downloadFile(wrapper, 'silent-send-backup.ssbackup');
    alert('Encrypted backup saved. You will need the password to import it.');
  } catch (e) {
    alert('Encryption failed: ' + e.message);
  }
}

async function importAll(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    let data;

    if (parsed.encrypted) {
      // Encrypted backup
      const password = prompt('Enter the password for this backup:');
      if (!password) return;
      try {
        data = await SilentSendCrypto.decrypt(parsed.data, password);
      } catch (err) {
        alert('Wrong password or corrupted file.');
        return;
      }
    } else {
      // Plain backup
      data = parsed;
    }

    if (!data.version) {
      alert('Not a valid Silent Send backup file.');
      return;
    }

    if (!confirm('This will replace all your current data. Continue?')) return;

    // Restore
    if (data.identity) await api.storage.local.set({ ss_identity: data.identity });
    if (data.mappings) await api.storage.local.set({ ss_mappings: data.mappings });
    if (data.settings) await api.storage.local.set({ ss_settings: data.settings });

    // Refresh UI
    mappings = await Storage.getMappings();
    settings = await Storage.getSettings();
    renderMappings();
    renderDomains();
    renderLog();

    alert('Import complete. Reload the extension for changes to take effect.');
  } catch (err) {
    alert('Failed to import: ' + err.message);
  }

  // Reset file input
  e.target.value = '';
}

// ----------------------------------------------------------------
// File-based auto-sync (File System Access API)
// ----------------------------------------------------------------

let syncDirHandle = null;
const SYNC_FILE_NAME = 'silent-send-sync.json';

async function initFileSync() {
  syncDirHandle = await SilentSendSync.loadSyncDirHandle();
  updateFileSyncUI();
  if (syncDirHandle) {
    await checkFileSyncUpdate();
  }
}

async function pickSyncFolder() {
  if (!window.showDirectoryPicker) {
    setFileSyncStatus('Your browser does not support the File System Access API.', 'error');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ss-sync' });
    syncDirHandle = handle;
    await SilentSendSync.saveSyncDirHandle(handle);
    updateFileSyncUI();
    // Write current settings immediately so the file exists for the other browser
    await writeToSyncFile();
    setFileSyncStatus('Sync folder set. Settings will sync automatically.', 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') {
      setFileSyncStatus('Could not set sync folder: ' + e.message, 'error');
    }
  }
}

async function writeToSyncFile() {
  if (!syncDirHandle) return;
  try {
    // Re-verify permission is still granted (required after browser restart)
    const perm = await syncDirHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;

    const data = await SilentSendSync._getAllData();
    const fileHandle = await syncDirHandle.getFileHandle(SYNC_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch (e) {
    // Permission denied or folder removed — don't spam errors
    console.warn('[Silent Send] writeToSyncFile failed:', e.message);
  }
}

async function checkFileSyncUpdate() {
  if (!syncDirHandle) return;
  try {
    const perm = await syncDirHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'prompt') {
      // Need a user gesture to re-request — skip silently
      return;
    }
    if (perm !== 'granted') return;

    const fileHandle = await syncDirHandle.getFileHandle(SYNC_FILE_NAME);
    const file = await fileHandle.getFile();
    const data = JSON.parse(await file.text());

    if (!data.version || !data.lastModified) return;

    const local = await SilentSendSync._getAllData();
    if (data.lastModified > (local.lastModified || 0)) {
      await SilentSendSync._applyData(data);
      mappings = await Storage.getMappings();
      settings = await Storage.getSettings();
      $('#browserSync').checked = settings.browserSync === true;
      renderMappings();
      renderDomains();
      renderLog();
      setFileSyncStatus(
        'Auto-synced from folder (' + new Date(data.lastModified).toLocaleString() + ').',
        'ok'
      );
    }
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      console.warn('[Silent Send] checkFileSyncUpdate failed:', e.message);
    }
  }
}

function updateFileSyncUI() {
  const nameEl = $('#syncFolderName');
  const clearBtn = $('#btnClearSyncFolder');
  const pickBtn = $('#btnPickSyncFolder');
  if (!nameEl) return;
  if (syncDirHandle) {
    nameEl.textContent = syncDirHandle.name + '/';
    clearBtn.style.display = '';
    pickBtn.textContent = 'Change Folder';
  } else {
    nameEl.textContent = '';
    clearBtn.style.display = 'none';
    pickBtn.textContent = 'Choose Sync Folder';
  }
}

function setFileSyncStatus(msg, type) {
  const el = $('#fileSyncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

function setSyncStatus(msg, type) {
  const el = $('#syncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
