import SubstitutionEngine from '../lib/substitution-engine.js';
import SmartPatterns from '../lib/smart-patterns.js';
import Storage from '../lib/storage.js';
import api from '../lib/browser-polyfill.js';

// --- State ---
let mappings = [];
let identity = {};
let settings = {};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  identity = await Storage.getIdentity();
  settings = await Storage.getSettings();

  renderMappings();
  renderActivity();
  loadIdentityForm();
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

  // Save identity
  $('#btnSaveIdentity').addEventListener('click', saveIdentity);

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

// --- Identity ---
function loadIdentityForm() {
  const first = (identity.names || []).find(n => n.type === 'first');
  const last = (identity.names || []).find(n => n.type === 'last');
  const email = (identity.emails || [])[0];
  const user = (identity.usernames || [])[0];
  const phone = (identity.phones || [])[0];

  if (first) {
    $('#idFirstReal').value = first.real || '';
    $('#idFirstSub').value = first.substitute || '';
  }
  if (last) {
    $('#idLastReal').value = last.real || '';
    $('#idLastSub').value = last.substitute || '';
  }
  if (email) {
    $('#idEmailReal').value = email.real || '';
    $('#idEmailSub').value = email.substitute || '';
  }
  $('#idCatchAllEmail').value = identity.catchAllEmail || '';
  if (user) {
    $('#idUserReal').value = user.real || '';
    $('#idUserSub').value = user.substitute || '';
  }
  const host = (identity.hostnames || [])[0];
  if (host) {
    $('#idHostReal').value = host.real || '';
    $('#idHostSub').value = host.substitute || '';
  }
  if (phone) {
    $('#idPhoneReal').value = phone.real || '';
    $('#idPhoneSub').value = phone.substitute || '';
  }
}

async function saveIdentity() {
  const names = [];
  const firstReal = $('#idFirstReal').value.trim();
  const firstSub = $('#idFirstSub').value.trim();
  if (firstReal && firstSub) {
    names.push({ real: firstReal, substitute: firstSub, type: 'first' });
  }
  const lastReal = $('#idLastReal').value.trim();
  const lastSub = $('#idLastSub').value.trim();
  if (lastReal && lastSub) {
    names.push({ real: lastReal, substitute: lastSub, type: 'last' });
  }

  const emails = [];
  const emailReal = $('#idEmailReal').value.trim();
  const emailSub = $('#idEmailSub').value.trim();
  if (emailReal && emailSub) {
    emails.push({ real: emailReal, substitute: emailSub });
  }

  const usernames = [];
  const userReal = $('#idUserReal').value.trim();
  const userSub = $('#idUserSub').value.trim();
  if (userReal && userSub) {
    usernames.push({ real: userReal, substitute: userSub });
  }

  const hostnames = [];
  const hostReal = $('#idHostReal').value.trim();
  const hostSub = $('#idHostSub').value.trim();
  if (hostReal && hostSub) {
    hostnames.push({ real: hostReal, substitute: hostSub });
  }

  const phones = [];
  const phoneReal = $('#idPhoneReal').value.trim();
  const phoneSub = $('#idPhoneSub').value.trim();
  if (phoneReal && phoneSub) {
    phones.push({ real: phoneReal, substitute: phoneSub });
  }

  identity = {
    names,
    emails,
    usernames,
    hostnames,
    phones,
    catchAllEmail: $('#idCatchAllEmail').value.trim(),
    emailDomains: identity.emailDomains || [],
    enabled: identity.enabled || { emails: true, names: true, usernames: true, phones: true, paths: true },
  };

  await Storage.saveIdentity(identity);

  // Flash save button
  const btn = $('#btnSaveIdentity');
  btn.textContent = 'Saved!';
  btn.style.background = '#059669';
  setTimeout(() => {
    btn.textContent = 'Save Identity';
    btn.style.background = '';
  }, 1500);
}

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
// Runs both smart patterns AND explicit mappings, shows combined result
function renderTestDiff() {
  const input = $('#testInput').value;
  const output = $('#diffOutput');
  const stats = $('#diffStats');

  if (!input) {
    output.innerHTML = '';
    stats.textContent = '';
    return;
  }

  // Smart patterns first (broader catches), then explicit mappings (specific overrides)
  const smartResult = SmartPatterns.substitute(input, identity);
  const explicitResult = SubstitutionEngine.substitute(smartResult.text, mappings);

  const allReplacements = [...smartResult.replacements, ...explicitResult.replacements];
  const finalText = explicitResult.text;

  // Simple diff: highlight differences
  if (finalText === input) {
    output.textContent = input;
    stats.textContent = 'No substitutions detected';
    return;
  }

  // Build a visual diff by running smart patterns on original to find positions
  // For display, we re-run on the original to get positions
  const smartPositions = findReplacementPositions(input, identity, mappings);

  if (smartPositions.length === 0) {
    output.textContent = finalText;
  } else {
    // Build highlighted output from the final text
    // Simpler approach: show the final text with replaced values highlighted
    let html = escapeHtml(finalText);
    for (const r of allReplacements) {
      const escapedReplaced = escapeHtml(r.replaced);
      html = html.replace(
        escapedReplaced,
        `<span class="sub-highlight" title="Was: ${escapeHtml(r.original)} [${r.pattern || r.category}]">${escapedReplaced}</span>`
      );
    }
    output.innerHTML = html;
  }

  const smartCount = smartResult.replacements.length;
  const explicitCount = explicitResult.replacements.length;
  const parts = [];
  if (smartCount > 0) parts.push(`${smartCount} smart`);
  if (explicitCount > 0) parts.push(`${explicitCount} explicit`);
  stats.textContent = `${allReplacements.length} substitution${allReplacements.length !== 1 ? 's' : ''} (${parts.join(', ')})`;
}

function findReplacementPositions(text, ident, maps) {
  const positions = [];
  const r1 = SmartPatterns.substitute(text, ident);
  positions.push(...r1.replacements);
  const r2 = SubstitutionEngine.substitute(r1.text, maps);
  positions.push(...r2.replacements);
  return positions;
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
