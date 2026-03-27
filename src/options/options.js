import Storage from '../lib/storage.js';
import SilentSendCrypto from '../lib/crypto.js';
import SilentSendSync from '../lib/sync.js';
import VersionHistory from '../lib/version-history.js';
import ImportParser from '../lib/import-parser.js';
import SilentSendMerge from '../lib/merge.js';
import OrgPolicy from '../lib/org-policy.js';
import TamperGuard from '../lib/tamper-guard.js';
import api from '../lib/browser-polyfill.js';

let mappings = [];
let settings = {};
let passwordsRevealed = false;

const $ = (sel) => document.querySelector(sel);

// --- Safe innerHTML replacement (AMO-compliant) ---
function safeHTML(el, html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  el.replaceChildren(...Array.from(doc.body.childNodes));
}

document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  settings = await Storage.getSettings();

  // Apply settings to UI
  $('#showHighlights').checked = settings.showHighlights || false;
  $('#secretScanning').checked = settings.secretScanning !== false;
  $('#autoDetect').checked = settings.autoDetect !== false;
  $('#autoRedactDetected').checked = settings.autoRedactDetected !== false;
  $('#autoAddDetected').checked = settings.autoAddDetected !== false;
  $('#maxLogEntries').value = settings.maxLogEntries || 100;
  $('#browserSync').checked = settings.browserSync === true;

  renderMappings();
  renderPasswords();
  renderDomains();
  renderLog();

  // --- New features ---
  await initAutoSyncUI();
  await initVersionHistoryUI();
  await initDeviceDashboard();
  await initOrgUI();
  await initTamperUI();
  await checkConflicts();

  // --- Sync Encryption UI ---
  await initSyncEncryptionUI();

  // --- Sync section ---
  $('#browserSync').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const encEnabled = await SilentSendSync.isEncryptionEnabled();
      if (!encEnabled) {
        e.target.checked = false;
        setSyncStatus('Encryption must be enabled before syncing. Set up encryption first.', 'error');
        return;
      }
      await Storage.saveSettings({ browserSync: true });
      await SilentSendSync.pushToSyncStorage();
      setSyncStatus('Browser account sync enabled. Your settings will sync automatically.', 'ok');
    } else {
      await Storage.saveSettings({ browserSync: false });
      setSyncStatus('Browser account sync disabled.', 'neutral');
    }
  });

  $('#btnGenerateSyncCode').addEventListener('click', async () => {
    const code = await SilentSendSync.exportSyncCode();
    if (code?.needsEncryption) {
      setSyncStatus('Encryption must be enabled before syncing. Set up encryption first.', 'error');
      return;
    }
    if (code?.needsAuth) {
      setSyncStatus('Authentication required to encrypt sync code.', 'warn');
      showSyncAuthPrompt();
      return;
    }
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
    if (result.needsAuth) {
      setSyncStatus('Authentication required to decrypt this sync code.', 'warn');
      showSyncAuthPrompt();
    } else if (result.success) {
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
  // Tell the service worker the user has seen any pending sync notification
  api.runtime.sendMessage({ type: 'sync:notification-seen' }).catch(() => {});
  await api.storage.local.remove('ss_sync_notification');

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

  // --- GitHub Gist sync ---
  // Restore saved token (session only — never persisted to storage)
  {
    const stored = await api.storage.local.get('ss_gist_id');
    if (stored.ss_gist_id) {
      setGistSyncStatus(`Gist ID: ${stored.ss_gist_id.slice(0, 12)}…`, 'ok');
    }
  }

  $('#btnGistPush').addEventListener('click', async () => {
    const token = $('#gistToken').value.trim();
    if (!token) { setGistSyncStatus('Enter your GitHub PAT first.', 'warn'); return; }
    setGistSyncStatus('Pushing…', 'neutral');
    const r = await SilentSendSync.pushToGist(token);
    if (r.needsEncryption) {
      setGistSyncStatus('Encryption must be enabled before syncing.', 'error');
    } else if (r.needsAuth) {
      setGistSyncStatus('Authentication required to encrypt.', 'warn');
      showSyncAuthPrompt();
    } else if (r.success) {
      setGistSyncStatus(`Pushed. Gist ID: ${r.gistId.slice(0, 12)}…`, 'ok');
    } else {
      setGistSyncStatus('Push failed: ' + r.reason, 'error');
    }
  });

  $('#btnGistPull').addEventListener('click', async () => {
    const token = $('#gistToken').value.trim();
    if (!token) { setGistSyncStatus('Enter your GitHub PAT first.', 'warn'); return; }
    setGistSyncStatus('Pulling…', 'neutral');
    const r = await SilentSendSync.pullFromGist(token);
    if (r.needsAuth) {
      setGistSyncStatus('Authentication required to decrypt.', 'warn');
      showSyncAuthPrompt();
    } else if (!r.success) {
      setGistSyncStatus('Pull failed: ' + r.reason, 'error');
    } else if (r.imported) {
      setGistSyncStatus(`Pulled (${r.time}). Refreshing…`, 'ok');
      mappings = await Storage.getMappings();
      settings = await Storage.getSettings();
      renderMappings();
      renderDomains();
      renderLog();
    } else {
      setGistSyncStatus('Already up to date.', 'ok');
    }
  });

  // --- Custom URL sync ---
  $('#btnUrlPush').addEventListener('click', async () => {
    const url = $('#customSyncUrl').value.trim();
    if (!url) { setUrlSyncStatus('Enter a URL first.', 'warn'); return; }
    const headers = parseHeadersField($('#customSyncHeaders').value);
    setUrlSyncStatus('Pushing…', 'neutral');
    const r = await SilentSendSync.pushToUrl({ url, headers });
    if (r.needsEncryption) {
      setUrlSyncStatus('Encryption must be enabled before syncing.', 'error');
    } else if (r.needsAuth) {
      setUrlSyncStatus('Authentication required to encrypt.', 'warn');
      showSyncAuthPrompt();
    } else if (r.success) {
      setUrlSyncStatus('Pushed successfully.', 'ok');
    } else {
      setUrlSyncStatus('Push failed: ' + r.reason, 'error');
    }
  });

  $('#btnUrlPull').addEventListener('click', async () => {
    const url = $('#customSyncUrl').value.trim();
    if (!url) { setUrlSyncStatus('Enter a URL first.', 'warn'); return; }
    const headers = parseHeadersField($('#customSyncHeaders').value);
    setUrlSyncStatus('Pulling…', 'neutral');
    const r = await SilentSendSync.pullFromUrl({ url, headers });
    if (r.needsAuth) {
      setUrlSyncStatus('Authentication required to decrypt.', 'warn');
      showSyncAuthPrompt();
    } else if (!r.success) {
      setUrlSyncStatus('Pull failed: ' + r.reason, 'error');
    } else if (r.imported) {
      setUrlSyncStatus(`Pulled (${r.time}). Refreshing…`, 'ok');
      mappings = await Storage.getMappings();
      settings = await Storage.getSettings();
      renderMappings();
      renderDomains();
      renderLog();
    } else {
      setUrlSyncStatus('Already up to date.', 'ok');
    }
  });

  // Transfer data
  $('#btnExportAll').addEventListener('click', exportAllPlain);
  $('#btnExportEncrypted').addEventListener('click', exportAllEncrypted);
  $('#btnImportAll').addEventListener('click', () => $('#fileImportAll').click());
  $('#fileImportAll').addEventListener('change', importAll);

  // Bulk import
  $('#btnBulkImport').addEventListener('click', () => $('#fileBulkImport').click());
  $('#fileBulkImport').addEventListener('change', handleBulkImport);
  $('#btnCancelBulkImport').addEventListener('click', () => {
    $('#bulkImportPreview').style.display = 'none';
    $('#fileBulkImport').value = '';
  });

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
    await Storage.saveSettings({ maxLogEntries: parseInt(e.target.value, 10) || 100 });
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

  // Password reveal/hide
  $('#btnRevealPasswords').addEventListener('click', async () => {
    const pw = $('#passwordRevealKey').value;
    if (!pw) {
      setPasswordRevealStatus('Enter your vault password.', 'warn');
      return;
    }
    const result = await SilentSendSync.authenticate(pw);
    if (result.success) {
      passwordsRevealed = true;
      $('#passwordsLocked').style.display = 'none';
      $('#passwordsUnlocked').style.display = 'block';
      $('#passwordRevealKey').value = '';
      renderPasswords();
    } else {
      setPasswordRevealStatus('Wrong password.', 'error');
    }
  });

  $('#btnHidePasswords').addEventListener('click', () => {
    passwordsRevealed = false;
    $('#passwordsLocked').style.display = 'block';
    $('#passwordsUnlocked').style.display = 'none';
    renderPasswords();
  });

  $('#passwordRevealKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnRevealPasswords').click();
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
  // Exclude password-category mappings — they have their own section
  const nonPasswordMappings = mappings.filter(m => m.category !== 'password');

  if (nonPasswordMappings.length === 0) {
    safeHTML(tbody, '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">No mappings configured</td></tr>');
    return;
  }

  safeHTML(tbody, nonPasswordMappings
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
    .join(''));

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

// --- Passwords Section ---

function renderPasswords() {
  const passwordMappings = mappings.filter(m => m.category === 'password');
  const tbody = $('#passwordTableBody');
  const noMsg = $('#noPasswordsMsg');

  if (passwordMappings.length === 0) {
    tbody.replaceChildren();
    noMsg.style.display = 'block';
    return;
  }

  noMsg.style.display = 'none';

  safeHTML(tbody, passwordMappings.map(m => {
    const displayReal = passwordsRevealed
      ? escapeHtml(m.real)
      : '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;';

    return `
    <tr data-id="${m.id}">
      <td class="real" style="font-family:monospace;font-size:12px">${displayReal}</td>
      <td class="sub" style="font-size:12px">${escapeHtml(m.substitute)}</td>
      <td>
        <label class="toggle" style="width:32px;height:18px">
          <input type="checkbox" class="toggle-pw-enabled" ${m.enabled ? 'checked' : ''}>
          <span class="toggle-slider" style="border-radius:18px"></span>
        </label>
      </td>
      <td><button class="btn btn-sm btn-danger btn-delete-pw">&times;</button></td>
    </tr>`;
  }).join(''));

  // Bind delete
  tbody.querySelectorAll('.btn-delete-pw').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      await Storage.deleteMapping(id);
      mappings = mappings.filter(m => m.id !== id);
      renderPasswords();
      renderMappings();
    });
  });

  // Bind toggle
  tbody.querySelectorAll('.toggle-pw-enabled').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.closest('tr').dataset.id;
      await Storage.updateMapping(id, { enabled: cb.checked });
      const m = mappings.find(m => m.id === id);
      if (m) m.enabled = cb.checked;
    });
  });
}

function setPasswordRevealStatus(msg, type) {
  const el = $('#passwordRevealStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

async function renderLog() {
  const log = await Storage.getLog();
  $('#logCount').textContent = `${log.length} entries`;

  const list = $('#logList');
  if (log.length === 0) {
    safeHTML(list, '<div style="text-align:center;color:#9ca3af;padding:24px">No activity logged</div>');
    return;
  }

  safeHTML(list, log
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
    .join(''));
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
    safeHTML(list, '<div style="text-align:center;color:#9ca3af;padding:12px;font-size:13px">No custom domains. Built-in sites (Claude, ChatGPT, Grok, Gemini, localhost) are always active.</div>');
    return;
  }

  safeHTML(list, domains
    .map((d, i) => `
      <div class="domain-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:#f9fafb;border-radius:6px;margin-bottom:4px">
        <span style="font-size:13px;font-family:monospace">${escapeHtml(d)}</span>
        <button class="btn btn-sm btn-danger btn-remove-domain" data-index="${i}">&times;</button>
      </div>
    `)
    .join(''));

  list.querySelectorAll('.btn-remove-domain').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const domains = settings.customDomains || [];
      const removed = domains.splice(idx, 1)[0];
      settings.customDomains = domains;
      await Storage.saveSettings({ customDomains: domains });

      // Revoke browser permission for the removed domain
      if (removed) {
        try {
          await api.permissions.remove({ origins: [removed + '/*'] });
        } catch (e) { /* non-fatal */ }
      }

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
  // Hide the entire section if File System Access API isn't supported
  if (!window.showDirectoryPicker) {
    const section = $('#fileSyncSection');
    if (section) section.style.display = 'none';
    return;
  }

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
    const perm = await syncDirHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;

    const data = await SilentSendSync._getAllData();

    // Encrypt if enabled
    const encResult = await SilentSendSync._encryptForSync(data);
    if (encResult.needsAuth) return; // skip silently — will sync after auth
    const payload = encResult.data || data;

    const fileHandle = await syncDirHandle.getFileHandle(SYNC_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  } catch (e) {
    console.warn('[Silent Send] writeToSyncFile failed:', e.message);
  }
}

async function checkFileSyncUpdate() {
  if (!syncDirHandle) return;
  try {
    const perm = await syncDirHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'prompt') return;
    if (perm !== 'granted') return;

    const fileHandle = await syncDirHandle.getFileHandle(SYNC_FILE_NAME);
    const file = await fileHandle.getFile();
    let data = JSON.parse(await file.text());

    // Check timestamp before requiring auth
    const remoteMod = data.lastModified;
    if (!remoteMod) return;

    const local = await SilentSendSync._getAllData();
    if (remoteMod <= (local.lastModified || 0)) return;

    // New data exists — decrypt if encrypted
    if (data._ssEncrypted) {
      const decResult = await SilentSendSync._decryptFromSync(data);
      if (decResult.needsAuth) {
        setFileSyncStatus('New sync data available — authentication required.', 'warn');
        showSyncAuthPrompt();
        return;
      }
      if (!decResult.data) {
        setFileSyncStatus('Failed to decrypt sync file.', 'error');
        return;
      }
      data = decResult.data;
    }

    if (!data.version) return;

    await SilentSendSync._applyData(data, 'file');
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

function setGistSyncStatus(msg, type) {
  const el = $('#gistSyncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

function setUrlSyncStatus(msg, type) {
  const el = $('#urlSyncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

function parseHeadersField(val) {
  if (!val || !val.trim()) return {};
  try {
    return JSON.parse(val.trim());
  } catch {
    return {};
  }
}

function setSyncStatus(msg, type) {
  const el = $('#syncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

// ----------------------------------------------------------------
// Sync Encryption UI
// ----------------------------------------------------------------

async function initSyncEncryptionUI() {
  const isEnabled = await SilentSendSync.isEncryptionEnabled();

  if (isEnabled) {
    showEncryptionConfigured();
  } else {
    showEncryptionNotConfigured();
  }

  // Hide WebAuthn option if not available
  if (!SilentSendCrypto.isWebAuthnAvailable()) {
    const label = $('#syncEncWebAuthnLabel');
    if (label) label.style.display = 'none';
  }

  // Setup encryption button
  $('#btnSetupEncryption').addEventListener('click', async () => {
    const password = $('#syncEncPassword').value;
    const confirm = $('#syncEncPasswordConfirm').value;

    if (!password) {
      setSyncEncStatus('Enter a password.', 'warn');
      return;
    }
    if (password !== confirm) {
      setSyncEncStatus('Passwords do not match.', 'error');
      return;
    }

    const enableTOTP = $('#syncEncTOTP').checked;
    const enableWebAuthn = $('#syncEncWebAuthn').checked;
    const ttlDays = parseInt($('#syncEncTTL').value, 10);

    setSyncEncStatus('Setting up encryption...', 'neutral');

    const result = await SilentSendSync.setupEncryption({
      password,
      enableTOTP,
      authMethod: enableTOTP ? 'both' : 'password',
      ttlDays,
      enableWebAuthn,
    });

    if (!result.success) {
      setSyncEncStatus('Setup failed: ' + result.reason, 'error');
      return;
    }

    // Show TOTP secret if enabled
    if (result.totpSecret) {
      $('#totpSecretDisplay').textContent = result.totpSecret;
      $('#totpURIDisplay').textContent = result.totpURI;
      $('#totpSetupResult').style.display = 'block';
    }

    // Clear password fields
    $('#syncEncPassword').value = '';
    $('#syncEncPasswordConfirm').value = '';

    showEncryptionConfigured();
    setSyncEncStatus('Encryption enabled. All sync data will be encrypted.', 'ok');
  });

  // Dismiss TOTP setup
  $('#btnDismissTOTP').addEventListener('click', () => {
    $('#totpSetupResult').style.display = 'none';
  });

  // Disable encryption
  $('#btnDisableEncryption').addEventListener('click', async () => {
    if (!window.confirm('Disable sync encryption? Existing encrypted sync data will become unreadable.')) return;
    await SilentSendSync.disableEncryption();
    $('#browserSync').checked = false;
    showEncryptionNotConfigured();
    setSyncEncStatus('Encryption disabled. All sync channels have been turned off.', 'neutral');
  });

  // Change password
  $('#btnChangeEncPassword').addEventListener('click', async () => {
    const oldPassword = window.prompt('Enter current password:');
    if (!oldPassword) return;

    // Verify old password
    const authResult = await SilentSendSync.authenticate(oldPassword);
    if (!authResult.success) {
      setSyncEncStatus('Wrong current password.', 'error');
      return;
    }

    const newPassword = window.prompt('Enter new password:');
    if (!newPassword) return;
    const confirmNew = window.prompt('Confirm new password:');
    if (newPassword !== confirmNew) {
      setSyncEncStatus('New passwords do not match.', 'error');
      return;
    }

    // Get current config to preserve TOTP and other settings
    const config = await SilentSendSync._getSyncEncryption();
    const result = await SilentSendSync.setupEncryption({
      password: newPassword,
      enableTOTP: !!config.totpSecret,
      authMethod: config.authMethod,
      ttlDays: config.ttlDays,
      enableWebAuthn: config.webauthn,
    });

    if (result.success) {
      setSyncEncStatus('Password changed successfully.', 'ok');
    } else {
      setSyncEncStatus('Failed: ' + result.reason, 'error');
    }
  });

  // Auth prompt — Unlock with password (first-device or re-verify)
  $('#btnSyncAuth').addEventListener('click', async () => {
    const password = $('#syncAuthPassword').value;
    const totpCode = $('#syncAuthTOTPForPassword').value;

    if (!password) {
      setSyncAuthStatus('Enter your password.', 'warn');
      return;
    }

    // Check if this is re-verification (key exists) or first-device (needs full auth)
    const cached = await SilentSendCrypto.getCachedKey();
    let result;
    if (cached) {
      // Re-verification — password alone is enough
      result = await SilentSendSync.reverifyWithPassword(password);
    } else {
      // First device — full auth with password + TOTP if configured
      result = await SilentSendSync.authenticate(password, totpCode || undefined);
    }

    if (result.success) {
      $('#syncAuthPrompt').style.display = 'none';
      $('#syncAuthPassword').value = '';
      $('#syncAuthTOTPForPassword').value = '';
      setSyncEncStatus(cached ? 'Re-verified with password.' : 'Authenticated. Sync data unlocked.', 'ok');
    } else {
      setSyncAuthStatus(result.reason, 'error');
    }
  });

  // Re-verify with TOTP alone (key must already exist)
  $('#btnSyncAuthTOTP').addEventListener('click', async () => {
    const totpCode = $('#syncAuthTOTP').value;
    if (!totpCode || totpCode.length < 6) {
      setSyncAuthStatus('Enter your 6-digit TOTP code.', 'warn');
      return;
    }

    const result = await SilentSendSync.reverifyWithTOTP(totpCode);
    if (result.success) {
      $('#syncAuthPrompt').style.display = 'none';
      $('#syncAuthTOTP').value = '';
      setSyncEncStatus('Re-verified with TOTP.', 'ok');
    } else {
      setSyncAuthStatus(result.reason, 'error');
    }
  });

  // Re-verify with biometric/PIN (key must already exist)
  $('#btnSyncAuthBiometric').addEventListener('click', async () => {
    setSyncAuthStatus('Waiting for biometric...', 'neutral');
    const verified = await SilentSendCrypto.webAuthnAuthenticate();
    if (verified) {
      const config = await SilentSendSync._getSyncEncryption();
      const ttlDays = config?.ttlDays ?? 90;
      await SilentSendCrypto.markVerified(ttlDays);
      $('#syncAuthPrompt').style.display = 'none';
      setSyncEncStatus('Re-verified via biometric.', 'ok');
    } else {
      setSyncAuthStatus('Biometric failed. Try TOTP or password.', 'error');
    }
  });
}

async function showEncryptionConfigured() {
  $('#encryptionNotConfigured').style.display = 'none';
  $('#encryptionConfigured').style.display = 'block';

  const config = await SilentSendSync._getSyncEncryption();
  if (config) {
    const parts = [];
    if (config.authMethod === 'both') parts.push('Password + TOTP');
    else if (config.authMethod === 'totp') parts.push('TOTP');
    else parts.push('Password');

    if (config.webauthn) parts.push('Biometric re-auth');

    const ttl = config.ttlDays === -1 ? 'never re-verify'
      : config.ttlDays === 0 ? 're-verify each session'
      : `re-verify every ${config.ttlDays}d`;
    parts.push(ttl);

    $('#encryptionInfo').textContent = `(${parts.join(' · ')})`;
  }

  // Check if password entry is needed (first time on this device)
  const needsAuth = await SilentSendSync.needsAuth();
  if (needsAuth) {
    showSyncAuthPrompt('first-device');
  } else {
    // Key exists — check if re-verification is needed
    const needsReverify = await SilentSendSync.needsReverification();
    if (needsReverify) {
      showSyncAuthPrompt('reverify');
    }
  }
}

function showEncryptionNotConfigured() {
  $('#encryptionNotConfigured').style.display = 'block';
  $('#encryptionConfigured').style.display = 'none';
  $('#syncAuthPrompt').style.display = 'none';
  $('#totpSetupResult').style.display = 'none';
}

/**
 * Show the auth prompt.
 * @param {'first-device'|'reverify'|'decrypt'} mode
 *
 * first-device: No cached key — password (+ TOTP if configured) required.
 * reverify:     Key exists but TTL expired — any ONE of: biometric / TOTP / password.
 * decrypt:      Encrypted data arrived — same as first-device if no key, reverify if key exists.
 */
async function showSyncAuthPrompt(mode = 'decrypt') {
  const config = await SilentSendSync._getSyncEncryption();
  const promptEl = $('#syncAuthPrompt');
  promptEl.style.display = 'block';

  const isReverify = (mode === 'reverify') ||
    (mode === 'decrypt' && await SilentSendCrypto.getCachedKey());

  // Adjust header message
  const headerEl = promptEl.querySelector('p');
  if (mode === 'first-device') {
    headerEl.textContent = 'First time on this device — enter your sync encryption password';
  } else if (isReverify) {
    headerEl.textContent = 'Re-verification required — use any method below';
  } else {
    headerEl.textContent = 'First time on this device — enter your sync encryption password';
  }

  // First-device: show TOTP alongside password if configured
  const hasTOTP = config?.totpSecret || config?._totpEncrypted;
  if (!isReverify && hasTOTP) {
    $('#syncAuthTOTPForPassword').style.display = '';
  } else {
    $('#syncAuthTOTPForPassword').style.display = 'none';
  }

  // Re-verify alternatives section
  const reverifyOpts = $('#reverifyOptions');
  if (isReverify) {
    reverifyOpts.style.display = 'block';

    // Biometric button
    if (config?.webauthn && SilentSendCrypto.isWebAuthnAvailable()) {
      const hasCred = await SilentSendCrypto.hasWebAuthnCredential();
      $('#btnSyncAuthBiometric').style.display = hasCred ? '' : 'none';
    } else {
      $('#btnSyncAuthBiometric').style.display = 'none';
    }

    // TOTP re-verify option
    const totpGroup = $('#totpReverifyGroup');
    if (hasTOTP) {
      totpGroup.style.display = 'flex';
    } else {
      totpGroup.style.display = 'none';
    }
  } else {
    reverifyOpts.style.display = 'none';
    $('#btnSyncAuthBiometric').style.display = 'none';
  }
}

function setSyncEncStatus(msg, type) {
  const el = $('#syncEncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

function setSyncAuthStatus(msg, type) {
  const el = $('#syncAuthStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

// ----------------------------------------------------------------
// Auto Sync UI
// ----------------------------------------------------------------

async function initAutoSyncUI() {
  const config = await SilentSendSync.getAutoSyncConfig();
  if (config) {
    $('#autoSyncEnabled').checked = config.enabled || false;
    $('#autoSyncMethod').value = config.method || 'gist';
    $('#autoSyncInterval').value = String(config.interval || 15);
    updateAutoSyncStatus(config);
  }

  const saveAutoSync = async () => {
    const config = (await SilentSendSync.getAutoSyncConfig()) || {};
    config.enabled = $('#autoSyncEnabled').checked;
    config.method = $('#autoSyncMethod').value;
    config.interval = parseInt($('#autoSyncInterval').value, 10) || 15;

    // Always grab the latest token/URL from the page fields
    // AND persist them so they survive page reloads
    const gistToken = $('#gistToken').value.trim();
    if (gistToken) config.gistToken = gistToken;
    const customUrl = $('#customSyncUrl').value.trim();
    if (customUrl) config.url = customUrl;
    config.headers = parseHeadersField($('#customSyncHeaders').value);

    // Validate: need credentials for the chosen method
    if (config.enabled) {
      if (config.method === 'gist' && !config.gistToken) {
        setAutoSyncStatus('Enter your GitHub PAT in the Gist section above first.', 'warn');
        config.enabled = false;
        $('#autoSyncEnabled').checked = false;
      } else if (config.method === 'url' && !config.url) {
        setAutoSyncStatus('Enter a URL in the Custom URL section above first.', 'warn');
        config.enabled = false;
        $('#autoSyncEnabled').checked = false;
      }
    }

    await SilentSendSync.saveAutoSyncConfig(config);
    api.runtime.sendMessage({ type: 'autosync:config-changed' }).catch(() => {});
    updateAutoSyncStatus(config);
  };

  // Also save token when the Gist token field changes
  $('#gistToken').addEventListener('change', async () => {
    const config = (await SilentSendSync.getAutoSyncConfig()) || {};
    const token = $('#gistToken').value.trim();
    if (token) {
      config.gistToken = token;
      await SilentSendSync.saveAutoSyncConfig(config);
    }
  });

  $('#autoSyncEnabled').addEventListener('change', saveAutoSync);
  $('#autoSyncMethod').addEventListener('change', saveAutoSync);
  $('#autoSyncInterval').addEventListener('change', saveAutoSync);
}

function updateAutoSyncStatus(config) {
  if (!config?.enabled) {
    setAutoSyncStatus('Auto sync disabled.', 'neutral');
    return;
  }
  const parts = [];
  parts.push(`${config.method === 'gist' ? 'GitHub Gist' : 'Custom URL'} every ${config.interval}min`);
  if (config.lastPull) parts.push(`last pull: ${new Date(config.lastPull).toLocaleString()}`);
  if (config.lastPush) parts.push(`last push: ${new Date(config.lastPush).toLocaleString()}`);
  setAutoSyncStatus(parts.join(' · '), 'ok');
}

function setAutoSyncStatus(msg, type) {
  const el = $('#autoSyncStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

// ----------------------------------------------------------------
// Version History UI
// ----------------------------------------------------------------

async function initVersionHistoryUI() {
  $('#maxVersionHistory').value = settings.maxVersionHistory || 10;
  $('#maxVersionHistory').addEventListener('change', async (e) => {
    await Storage.saveSettings({ maxVersionHistory: parseInt(e.target.value, 10) || 10 });
  });

  $('#btnClearVersionHistory').addEventListener('click', async () => {
    if (!confirm('Clear all version history snapshots?')) return;
    await VersionHistory.clearAll();
    renderVersionHistory();
  });

  await renderVersionHistory();
}

async function renderVersionHistory() {
  const list = $('#versionHistoryList');
  const snapshots = await VersionHistory.getSnapshots();

  if (snapshots.length === 0) {
    safeHTML(list, '<div style="text-align:center;color:#9ca3af;padding:12px">No snapshots yet. Snapshots are created on each sync.</div>');
    return;
  }

  safeHTML(list, snapshots.map(s => {
    const time = new Date(s.timestamp).toLocaleString();
    const mappingCount = (s.data?.mappings || []).length;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:#f9fafb;border-radius:6px;margin-bottom:4px">
      <div>
        <span style="font-size:12px;font-weight:500">${time}</span>
        <span style="font-size:11px;color:#6b7280;margin-left:8px">via ${escapeHtml(s.source || 'unknown')}</span>
        <span style="font-size:11px;color:#9ca3af;margin-left:8px">${mappingCount} mappings</span>
      </div>
      <button class="btn btn-sm btn-restore-snapshot" data-id="${s.id}">Restore</button>
    </div>`;
  }).join(''));

  list.querySelectorAll('.btn-restore-snapshot').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      if (!confirm('Restore this snapshot? Current data will be overwritten.')) return;
      const snapshot = await VersionHistory.getSnapshot(id);
      if (snapshot?.data) {
        await SilentSendSync._applyData(snapshot.data, 'rollback');
        mappings = await Storage.getMappings();
        settings = await Storage.getSettings();
        renderMappings();
        renderDomains();
        renderLog();
        alert('Restored. Reload open AI tabs for changes to take effect.');
      }
    });
  });
}

// ----------------------------------------------------------------
// Connected Devices UI
// ----------------------------------------------------------------

async function initDeviceDashboard() {
  const deviceInfo = await SilentSendSync.getDeviceInfo();
  $('#deviceName').value = deviceInfo.name;

  $('#btnRenameDevice').addEventListener('click', async () => {
    const name = $('#deviceName').value.trim();
    if (!name) return;
    await SilentSendSync.setDeviceName(name);
    renderDevices();
  });

  await renderDevices();
}

async function renderDevices() {
  const list = $('#deviceList');
  const devices = await SilentSendSync.getDevices();
  const currentDevice = await SilentSendSync.getDeviceInfo();
  const entries = Object.values(devices);

  if (entries.length === 0) {
    safeHTML(list, '<div style="text-align:center;color:#9ca3af;padding:12px">No devices synced yet. Push or pull to register this device.</div>');
    return;
  }

  entries.sort((a, b) => (b.lastSync || 0) - (a.lastSync || 0));

  safeHTML(list, `<table style="width:100%;font-size:12px;border-collapse:collapse">
    <thead><tr style="text-align:left;border-bottom:1px solid #e5e7eb">
      <th style="padding:6px">Device</th>
      <th style="padding:6px">Browser</th>
      <th style="padding:6px">Last Sync</th>
      <th style="padding:6px"></th>
    </tr></thead>
    <tbody>${entries.map(d => {
      const isCurrent = d.id === currentDevice.id;
      const lastSync = d.lastSync ? new Date(d.lastSync).toLocaleString() : 'Never';
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px">${escapeHtml(d.name || 'Unknown')} ${isCurrent ? '<span style="color:#10b981;font-size:10px">(this)</span>' : ''}</td>
        <td style="padding:6px">${escapeHtml(d.browser || '?')}</td>
        <td style="padding:6px">${lastSync}</td>
        <td style="padding:6px">${!isCurrent ? `<button class="btn btn-sm btn-danger btn-remove-device" data-id="${d.id}">&times;</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`);

  list.querySelectorAll('.btn-remove-device').forEach(btn => {
    btn.addEventListener('click', async () => {
      await SilentSendSync.removeDevice(btn.dataset.id);
      renderDevices();
    });
  });
}

// ----------------------------------------------------------------
// Organization UI
// ----------------------------------------------------------------

async function initOrgUI() {
  const inOrg = await OrgPolicy.isInOrg();
  if (inOrg) {
    await showOrgJoined();
  } else {
    showOrgNotJoined();
  }

  $('#btnJoinOrgCode').addEventListener('click', async () => {
    const code = $('#orgInviteCode').value.trim();
    if (!code) { setOrgStatus('Enter an invite code.', 'warn'); return; }
    setOrgStatus('Joining...', 'neutral');
    const result = await OrgPolicy.joinOrg({ inviteCode: code });
    if (result.success) {
      setOrgStatus(`Joined ${result.orgName}.`, 'ok');
      await showOrgJoined();
    } else {
      setOrgStatus('Failed: ' + result.reason, 'error');
    }
  });

  $('#btnJoinOrgUrl').addEventListener('click', async () => {
    const url = $('#orgPolicyUrl').value.trim();
    if (!url) { setOrgStatus('Enter a policy URL.', 'warn'); return; }
    setOrgStatus('Joining...', 'neutral');
    const result = await OrgPolicy.joinOrg({ policyUrl: url });
    if (result.success) {
      setOrgStatus(`Joined ${result.orgName}.`, 'ok');
      await showOrgJoined();
    } else {
      setOrgStatus('Failed: ' + result.reason, 'error');
    }
  });

  $('#btnLeaveOrg').addEventListener('click', async () => {
    // Check tamper protection
    if (await TamperGuard.isActionProtected('changeOrgPolicy')) {
      const pw = await promptAdminPassword('Leave organization');
      if (!pw) return;
      const auth = await TamperGuard.verify(pw);
      if (!auth) { setOrgStatus('Wrong admin password.', 'error'); return; }
    }
    if (!confirm('Leave this organization? Org-required mappings will be removed.')) return;
    await OrgPolicy.leaveOrg();
    showOrgNotJoined();
    setOrgStatus('Left organization.', 'neutral');
  });
}

async function showOrgJoined() {
  $('#orgNotJoined').style.display = 'none';
  $('#orgJoined').style.display = 'block';

  const config = await OrgPolicy.getOrgConfig();
  const policy = await OrgPolicy.getPolicy();
  if (config) {
    $('#orgNameDisplay').textContent = config.orgName;
    $('#orgPolicyVersion').textContent = `v${policy?.version || '?'}`;
  }

  const compliance = await OrgPolicy.checkCompliance();
  const statusEl = $('#orgComplianceStatus');
  if (compliance.compliant) {
    safeHTML(statusEl, '<span style="color:#10b981">&#10003; Compliant — all required fields configured</span>');
  } else {
    safeHTML(statusEl, `<span style="color:#b45309">Missing: ${compliance.missing.join(', ')}</span>`);
  }

  const reqMappings = policy?.requiredMappings || [];
  const reqEl = $('#orgRequiredMappings');
  if (reqMappings.length > 0) {
    reqEl.textContent = `${reqMappings.length} required mapping(s) enforced by org policy`;
  } else {
    reqEl.textContent = '';
  }
}

function showOrgNotJoined() {
  $('#orgNotJoined').style.display = 'block';
  $('#orgJoined').style.display = 'none';
}

function setOrgStatus(msg, type) {
  const el = $('#orgStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

// ----------------------------------------------------------------
// Tamper Protection UI
// ----------------------------------------------------------------

async function initTamperUI() {
  const enabled = await TamperGuard.isEnabled();
  if (enabled) {
    $('#tamperNotEnabled').style.display = 'none';
    $('#tamperEnabled').style.display = 'block';
  }

  $('#btnEnableTamper').addEventListener('click', async () => {
    const pw = $('#tamperAdminPassword').value;
    const confirm = $('#tamperAdminPasswordConfirm').value;
    if (!pw) { setTamperStatus('Enter a password.', 'warn'); return; }
    if (pw !== confirm) { setTamperStatus('Passwords do not match.', 'error'); return; }

    const result = await TamperGuard.setup(pw);
    if (result.success) {
      $('#tamperNotEnabled').style.display = 'none';
      $('#tamperEnabled').style.display = 'block';
      $('#tamperAdminPassword').value = '';
      $('#tamperAdminPasswordConfirm').value = '';
      setTamperStatus('Tamper protection enabled.', 'ok');
    } else {
      setTamperStatus(result.reason, 'error');
    }
  });

  $('#btnDisableTamper').addEventListener('click', async () => {
    const pw = await promptAdminPassword('Disable tamper protection');
    if (!pw) return;
    const result = await TamperGuard.disable(pw);
    if (result.success) {
      $('#tamperNotEnabled').style.display = 'block';
      $('#tamperEnabled').style.display = 'none';
      setTamperStatus('Tamper protection disabled.', 'neutral');
    } else {
      setTamperStatus(result.reason, 'error');
    }
  });

  $('#btnChangeTamperPassword').addEventListener('click', async () => {
    const oldPw = await promptAdminPassword('Change admin password');
    if (!oldPw) return;
    const newPw = window.prompt('Enter new admin password:');
    if (!newPw) return;
    const confirmPw = window.prompt('Confirm new admin password:');
    if (newPw !== confirmPw) { setTamperStatus('Passwords do not match.', 'error'); return; }
    const result = await TamperGuard.changePassword(oldPw, newPw);
    if (result.success) {
      setTamperStatus('Admin password changed.', 'ok');
    } else {
      setTamperStatus(result.reason, 'error');
    }
  });
}

function setTamperStatus(msg, type) {
  const el = $('#tamperStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

/**
 * Show the admin auth dialog and return the password, or null if cancelled.
 */
function promptAdminPassword(reason) {
  return new Promise((resolve) => {
    const dialog = $('#adminAuthDialog');
    $('#adminAuthReason').textContent = reason;
    $('#adminAuthInput').value = '';
    $('#adminAuthStatus').textContent = '';
    dialog.showModal();

    const submit = () => {
      const pw = $('#adminAuthInput').value;
      if (!pw) {
        $('#adminAuthStatus').textContent = 'Enter password.';
        return;
      }
      dialog.close();
      cleanup();
      resolve(pw);
    };

    const cancel = () => {
      dialog.close();
      cleanup();
      resolve(null);
    };

    const onKey = (e) => { if (e.key === 'Enter') submit(); };

    const cleanup = () => {
      $('#btnAdminAuthSubmit').removeEventListener('click', submit);
      $('#btnAdminAuthCancel').removeEventListener('click', cancel);
      $('#adminAuthInput').removeEventListener('keydown', onKey);
    };

    $('#btnAdminAuthSubmit').addEventListener('click', submit);
    $('#btnAdminAuthCancel').addEventListener('click', cancel);
    $('#adminAuthInput').addEventListener('keydown', onKey);
    setTimeout(() => $('#adminAuthInput').focus(), 100);
  });
}

// ----------------------------------------------------------------
// Conflict Resolution UI
// ----------------------------------------------------------------

async function checkConflicts() {
  const result = await api.storage.local.get('ss_sync_conflicts');
  const conflicts = result.ss_sync_conflicts || [];
  const section = $('#conflictSection');

  if (conflicts.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  renderConflicts(conflicts);
}

function renderConflicts(conflicts) {
  const list = $('#conflictList');
  safeHTML(list, conflicts.map(c => `
    <div style="padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;margin-bottom:8px" data-conflict-id="${c.id}">
      <div style="font-size:12px;font-weight:500;margin-bottom:6px">${escapeHtml(c.path)}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <div style="flex:1;min-width:120px">
          <div style="font-size:10px;color:#6b7280;margin-bottom:2px">LOCAL (this device)</div>
          <code style="font-size:11px;background:#f3f4f6;padding:4px 6px;border-radius:4px;display:block;word-break:break-all">${escapeHtml(JSON.stringify(c.localValue))}</code>
        </div>
        <div style="flex:1;min-width:120px">
          <div style="font-size:10px;color:#6b7280;margin-bottom:2px">REMOTE (other device)</div>
          <code style="font-size:11px;background:#f3f4f6;padding:4px 6px;border-radius:4px;display:block;word-break:break-all">${escapeHtml(JSON.stringify(c.remoteValue))}</code>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm btn-primary btn-resolve" data-id="${c.id}" data-choice="local">Keep Local</button>
        <button class="btn btn-sm btn-resolve" data-id="${c.id}" data-choice="remote">Keep Remote</button>
      </div>
    </div>
  `).join(''));

  list.querySelectorAll('.btn-resolve').forEach(btn => {
    btn.addEventListener('click', async () => {
      const conflictId = btn.dataset.id;
      const choice = btn.dataset.choice;

      const result = await api.storage.local.get('ss_sync_conflicts');
      const conflicts = result.ss_sync_conflicts || [];
      const conflict = conflicts.find(c => c.id === conflictId);

      if (conflict) {
        // Apply resolution
        const local = await SilentSendSync._getAllData();
        SilentSendMerge.resolveConflict(local, conflict, choice);
        await SilentSendSync._applyData(local, 'conflict-resolution');

        // Remove resolved conflict
        const remaining = conflicts.filter(c => c.id !== conflictId);
        await api.storage.local.set({ ss_sync_conflicts: remaining });

        // Refresh
        mappings = await Storage.getMappings();
        settings = await Storage.getSettings();
        renderMappings();
        renderDomains();
        checkConflicts();
      }
    });
  });
}

// ----------------------------------------------------------------
// Bulk Import
// ----------------------------------------------------------------

let pendingImport = null;

async function handleBulkImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const result = ImportParser.parse(text, file.name);
    pendingImport = result;

    // Build summary
    const parts = [];
    if (result.identity.names.length) parts.push(`${result.identity.names.length} name(s)`);
    if (result.identity.emails.length) parts.push(`${result.identity.emails.length} email(s)`);
    if (result.identity.usernames.length) parts.push(`${result.identity.usernames.length} username(s)`);
    if (result.identity.phones.length) parts.push(`${result.identity.phones.length} phone(s)`);
    if (result.mappings.length) parts.push(`${result.mappings.length} mapping(s)`);

    const needsMapping = result.mappings.filter(m => m.needsMapping).length +
      result.identity.names.filter(n => !n.substitute).length +
      result.identity.emails.filter(e => !e.substitute).length +
      result.identity.usernames.filter(u => !u.substitute).length +
      result.identity.phones.filter(p => !p.substitute).length;

    safeHTML($('#bulkImportSummary'), `
      Found: ${parts.join(', ')}.
      ${needsMapping > 0 ? `<span style="color:#b45309">${needsMapping} item(s) need substitutes — you can add them after import.</span>` : ''}
    `);

    // Build preview list
    const items = [];
    for (const n of result.identity.names) {
      items.push(`<div><span style="color:#6b7280">name:</span> <strong>${escapeHtml(n.real)}</strong>${n.substitute ? ' → ' + escapeHtml(n.substitute) : ' <span style="color:#b45309">needs substitute</span>'}</div>`);
    }
    for (const e of result.identity.emails) {
      items.push(`<div><span style="color:#6b7280">email:</span> <strong>${escapeHtml(e.real)}</strong>${e.substitute ? ' → ' + escapeHtml(e.substitute) : ' <span style="color:#b45309">needs substitute</span>'}</div>`);
    }
    for (const u of result.identity.usernames) {
      items.push(`<div><span style="color:#6b7280">username:</span> <strong>${escapeHtml(u.real)}</strong>${u.substitute ? ' → ' + escapeHtml(u.substitute) : ' <span style="color:#b45309">needs substitute</span>'}</div>`);
    }
    for (const p of result.identity.phones) {
      items.push(`<div><span style="color:#6b7280">phone:</span> <strong>${escapeHtml(p.real)}</strong>${p.substitute ? ' → ' + escapeHtml(p.substitute) : ' <span style="color:#b45309">needs substitute</span>'}</div>`);
    }
    for (const m of result.mappings) {
      items.push(`<div><span style="color:#6b7280">${escapeHtml(m.category)}:</span> <strong>${escapeHtml(m.real)}</strong>${m.substitute ? ' → ' + escapeHtml(m.substitute) : ' <span style="color:#b45309">needs substitute</span>'}</div>`);
    }

    safeHTML($('#bulkImportItems'), items.slice(0, 50).join('') +
      (items.length > 50 ? `<div style="color:#6b7280;margin-top:4px">+${items.length - 50} more...</div>` : ''));

    $('#bulkImportPreview').style.display = 'block';

    // Wire up apply button
    $('#btnApplyBulkImport').onclick = applyBulkImport;

    setBulkImportStatus(`Parsed ${file.name} — review and click Apply.`, 'ok');
  } catch (err) {
    setBulkImportStatus('Failed to parse: ' + err.message, 'error');
  }

  e.target.value = '';
}

async function applyBulkImport() {
  if (!pendingImport) return;

  const result = pendingImport;
  let addedCount = 0;

  // Add to identity (first active profile)
  const profiles = await Storage.getProfiles();
  if (profiles.length > 0) {
    const profile = profiles.find(p => p.active) || profiles[0];

    if (result.identity.names.length) {
      profile.names = [...(profile.names || []), ...result.identity.names];
      addedCount += result.identity.names.length;
    }
    if (result.identity.emails.length) {
      profile.emails = [...(profile.emails || []), ...result.identity.emails];
      addedCount += result.identity.emails.length;
    }
    if (result.identity.usernames.length) {
      profile.usernames = [...(profile.usernames || []), ...result.identity.usernames];
      addedCount += result.identity.usernames.length;
    }
    if (result.identity.phones.length) {
      profile.phones = [...(profile.phones || []), ...result.identity.phones];
      addedCount += result.identity.phones.length;
    }

    await Storage.updateProfile(profile.id, profile);
  }

  // Add mappings
  for (const m of result.mappings) {
    await Storage.addMapping({
      real: m.real,
      substitute: m.substitute || '',
      category: m.category || 'general',
      caseSensitive: false,
    });
    addedCount++;
  }

  // Refresh UI
  mappings = await Storage.getMappings();
  renderMappings();

  $('#bulkImportPreview').style.display = 'none';
  pendingImport = null;

  const needsSubs = result.mappings.filter(m => !m.substitute).length +
    result.identity.names.filter(n => !n.substitute).length +
    result.identity.emails.filter(e => !e.substitute).length +
    result.identity.usernames.filter(u => !u.substitute).length +
    result.identity.phones.filter(p => !p.substitute).length;

  setBulkImportStatus(
    `Imported ${addedCount} items.${needsSubs > 0 ? ` ${needsSubs} still need substitutes — check Identity tab and Mappings.` : ''}`,
    'ok'
  );
}

function setBulkImportStatus(msg, type) {
  const el = $('#bulkImportStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok' ? '#10b981' : type === 'warn' ? '#f59e0b' : type === 'error' ? '#dc2626' : '#6b7280';
}

// ----------------------------------------------------------------
// Utility
// ----------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
