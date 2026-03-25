import Storage from '../lib/storage.js';

let mappings = [];
let settings = {};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  settings = await Storage.getSettings();

  // Apply settings to UI
  $('#showHighlights').checked = settings.showHighlights || false;
  $('#maxLogEntries').value = settings.maxLogEntries || 200;

  renderMappings();
  renderLog();

  // Settings listeners
  $('#showHighlights').addEventListener('change', async (e) => {
    await Storage.saveSettings({ showHighlights: e.target.checked });
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
