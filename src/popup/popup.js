import SubstitutionEngine from '../lib/substitution-engine.js';
import Storage from '../lib/storage.js';
import api from '../lib/browser-polyfill.js';

// --- State ---
let mappings = [];
let settings = {};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  settings = await Storage.getSettings();

  renderMappings();
  renderActivity();
  updateStatusDot();

  $('#enableToggle').checked = settings.enabled;

  // Tab switching
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');

      if (tab.dataset.tab === 'activity') renderActivity();
    });
  });

  // Enable toggle
  $('#enableToggle').addEventListener('change', async (e) => {
    settings.enabled = e.target.checked;
    await Storage.saveSettings(settings);
    updateStatusDot();
    api.runtime.sendMessage({
      type: 'update:settings',
      settings,
    });
  });

  // Reveal mode toggle
  $('#btnReveal').addEventListener('click', async () => {
    settings.revealMode = !settings.revealMode;
    await Storage.saveSettings(settings);
    $('#btnReveal').classList.toggle('active', settings.revealMode);
    api.runtime.sendMessage({
      type: 'update:settings',
      settings,
    });
  });

  $('#btnReveal').classList.toggle('active', settings.revealMode);

  // Add mapping
  $('#btnAdd').addEventListener('click', addMapping);
  $('#inputSub').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addMapping();
  });

  // Clear log
  $('#btnClearLog').addEventListener('click', async () => {
    await Storage.clearLog();
    renderActivity();
  });

  // Test tab - live diff
  $('#testInput').addEventListener('input', renderTestDiff);

  // Options link
  $('#btnOptions').addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
  });
});

// --- Add Mapping ---
async function addMapping() {
  const real = $('#inputReal').value.trim();
  const sub = $('#inputSub').value.trim();
  const category = $('#inputCategory').value;
  const caseSensitive = $('#inputCaseSensitive').checked;

  if (!real || !sub) return;

  const mapping = await Storage.addMapping({
    real,
    substitute: sub,
    category,
    caseSensitive,
  });

  mappings.push(mapping);
  renderMappings();

  // Clear inputs
  $('#inputReal').value = '';
  $('#inputSub').value = '';
  $('#inputCaseSensitive').checked = false;
  $('#inputReal').focus();
}

// --- Render Mappings ---
function renderMappings() {
  const list = $('#mappingList');

  if (mappings.length === 0) {
    list.innerHTML = '<div class="empty-state">No mappings yet. Add your first one above.</div>';
    return;
  }

  list.innerHTML = mappings
    .map(
      (m) => `
    <div class="mapping-item" data-id="${m.id}">
      <div class="mapping-values">
        <span class="mapping-real">${escapeHtml(m.real)}</span>
        &rarr;
        <span class="mapping-sub">${escapeHtml(m.substitute)}</span>
      </div>
      <span class="mapping-category">${m.category}</span>
      <div class="mapping-actions">
        <button class="btn-toggle" title="${m.enabled ? 'Disable' : 'Enable'}">${m.enabled ? '&#x2714;' : '&#x25CB;'}</button>
        <button class="btn-delete" title="Delete">&times;</button>
      </div>
    </div>
  `
    )
    .join('');

  // Bind actions
  list.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.mapping-item').dataset.id;
      await Storage.deleteMapping(id);
      mappings = mappings.filter((m) => m.id !== id);
      renderMappings();
    });
  });

  list.querySelectorAll('.btn-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.mapping-item');
      const id = item.dataset.id;
      const mapping = mappings.find((m) => m.id === id);
      if (!mapping) return;
      mapping.enabled = !mapping.enabled;
      await Storage.updateMapping(id, { enabled: mapping.enabled });
      renderMappings();
    });
  });
}

// --- Render Activity Log ---
async function renderActivity() {
  const log = await Storage.getLog();
  const list = $('#activityList');
  const countEl = $('#sessionCount');

  countEl.textContent = `${log.length} substitution${log.length !== 1 ? 's' : ''} logged`;

  if (log.length === 0) {
    list.innerHTML = '<div class="empty-state">No activity yet.</div>';
    return;
  }

  list.innerHTML = log
    .slice(0, 50)
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `
      <div class="activity-item">
        <span class="activity-time">${time}</span>
        <div class="activity-detail">
          <span class="activity-original">${escapeHtml(entry.original)}</span>
          &rarr;
          <span class="activity-replaced">${escapeHtml(entry.replaced)}</span>
        </div>
      </div>
    `;
    })
    .join('');
}

// --- Test Diff ---
function renderTestDiff() {
  const input = $('#testInput').value;
  const output = $('#diffOutput');
  const stats = $('#diffStats');

  if (!input) {
    output.innerHTML = '';
    stats.textContent = '';
    return;
  }

  const { text, replacements } = SubstitutionEngine.substitute(input, mappings);
  const chunks = SubstitutionEngine.diff(input, text, mappings);

  output.innerHTML = chunks
    .map((chunk) => {
      if (chunk.type === 'substituted') {
        return `<span class="sub-highlight" title="Was: ${escapeHtml(chunk.original)}">${escapeHtml(chunk.replacement)}</span>`;
      }
      return escapeHtml(chunk.text);
    })
    .join('');

  stats.textContent =
    replacements.length > 0
      ? `${replacements.length} substitution${replacements.length !== 1 ? 's' : ''} would be made`
      : 'No substitutions detected';
}

// --- Status Dot ---
function updateStatusDot() {
  const dot = $('#statusDot');
  dot.classList.toggle('disabled', !settings.enabled);
}

// --- Util ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
