import SubstitutionEngine from '../lib/substitution-engine.js';
import SmartPatterns from '../lib/smart-patterns.js';
import SecretScanner from '../lib/secret-scanner.js';
import Storage from '../lib/storage.js';
import api from '../lib/browser-polyfill.js';

// --- State ---
let mappings = [];
let identity = {};     // merged identity (all active profiles)
let profiles = [];     // all profiles
let currentProfileId = null;  // currently selected profile for editing
let settings = {};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  mappings = await Storage.getMappings();
  profiles = await Storage.getProfiles();
  identity = await Storage.getIdentity();
  settings = await Storage.getSettings();

  // Initialize profiles — create default if none exist
  if (profiles.length === 0) {
    const p = await Storage.addProfile('Personal');
    profiles = [p];
  }
  currentProfileId = profiles[0].id;

  renderProfileSelector();
  loadIdentityForm();
  renderMappings();
  renderActivity();
  updateStatusDot();
  checkFirstRun();

  $('#enableToggle').checked = settings.enabled;

  // Tab switching
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');

      if (tab.dataset.tab === 'activity') renderActivity();
      if (tab.dataset.tab === 'test') {
        // Reload merged identity from storage in case profiles were just saved
        Storage.getIdentity().then((id) => {
          identity = id;
          updateIdentityStatus();
        });
      }
      if (tab.dataset.tab === 'identity') {
        // Reload profiles
        Storage.getProfiles().then((p) => {
          profiles = p;
          renderProfileSelector();
          loadIdentityForm();
        });
      }
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

  // Profile controls
  $('#profileSelect').addEventListener('change', (e) => {
    currentProfileId = e.target.value;
    loadIdentityForm();
  });

  $('#btnAddProfile').addEventListener('click', async () => {
    const name = prompt('Profile name:', `Profile ${profiles.length + 1}`);
    if (!name) return;
    const p = await Storage.addProfile(name);
    profiles = await Storage.getProfiles();
    currentProfileId = p.id;
    renderProfileSelector();
    loadIdentityForm();
    checkFirstRun();
  });

  $('#btnRenameProfile').addEventListener('click', async () => {
    const profile = profiles.find(p => p.id === currentProfileId);
    if (!profile) return;
    const name = prompt('Rename profile:', profile.name);
    if (!name) return;
    await Storage.updateProfile(currentProfileId, { name });
    profiles = await Storage.getProfiles();
    renderProfileSelector();
  });

  $('#btnDeleteProfile').addEventListener('click', async () => {
    if (profiles.length <= 1) {
      alert('Cannot delete the last profile.');
      return;
    }
    const profile = profiles.find(p => p.id === currentProfileId);
    if (!confirm(`Delete profile "${profile?.name}"?`)) return;
    await Storage.deleteProfile(currentProfileId);
    profiles = await Storage.getProfiles();
    currentProfileId = profiles[0]?.id;
    renderProfileSelector();
    loadIdentityForm();
    identity = await Storage.getIdentity();
    checkFirstRun();
  });

  $('#profileActive').addEventListener('change', async (e) => {
    await Storage.updateProfile(currentProfileId, { active: e.target.checked });
    profiles = await Storage.getProfiles();
    identity = await Storage.getIdentity();
    renderProfileSelector();
    checkFirstRun();
  });

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

  // Test tab - live diff + reveal
  $('#testInput').addEventListener('input', renderTestDiff);
  $('#revealInput').addEventListener('input', renderRevealDiff);
  $('#btnCopyRevealed').addEventListener('click', copyRevealedText);

  // Test mode toggle (strip vs reveal)
  $$('.test-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.test-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      $('#stripMode').style.display = mode === 'strip' ? 'block' : 'none';
      $('#revealMode').style.display = mode === 'reveal' ? 'block' : 'none';
    });
  });

  // Options link
  $('#btnOptions').addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
  });
});

// --- Profiles ---
function renderProfileSelector() {
  const select = $('#profileSelect');
  select.innerHTML = profiles.map(p =>
    `<option value="${p.id}" ${p.id === currentProfileId ? 'selected' : ''}>` +
    `${escapeHtml(p.name)}${p.active ? '' : ' (off)'}` +
    `</option>`
  ).join('');

  const profile = profiles.find(p => p.id === currentProfileId);
  $('#profileActive').checked = profile?.active ?? true;
}

// --- Identity (dynamic multi-entry) ---

// Field configs for rendering
const FIELD_CONFIGS = {
  names: {
    container: 'idNames',
    placeholderReal: 'Real name',
    placeholderSub: 'Fake name',
    typeOptions: [{ value: 'first', label: '1st' }, { value: 'last', label: 'Last' }, { value: 'middle', label: 'Mid' }, { value: 'nick', label: 'Nick' }],
    defaultType: 'first',
  },
  emails: {
    container: 'idEmails',
    placeholderReal: 'you@gmail.com',
    placeholderSub: 'fake@example.com',
  },
  usernames: {
    container: 'idUsernames',
    placeholderReal: 'jsmith',
    placeholderSub: 'ademo',
  },
  hostnames: {
    container: 'idHostnames',
    placeholderReal: 'macbook-pro',
    placeholderSub: 'mycomputer',
  },
  phones: {
    container: 'idPhones',
    placeholderReal: '(555) 123-4567',
    placeholderSub: '(555) 000-0000',
  },
};

function renderFieldList(fieldName, items) {
  const config = FIELD_CONFIGS[fieldName];
  const container = $(`#${config.container}`);
  if (!container) return;

  if (!items || items.length === 0) {
    // Show one empty row
    items = [{ real: '', substitute: '', type: config.defaultType || '' }];
  }

  container.innerHTML = items.map((item, i) => {
    let typeHtml = '';
    if (config.typeOptions) {
      typeHtml = `<select class="id-type-select" data-index="${i}" style="padding:3px 2px;font-size:10px;border:1px solid #e5e7eb;border-radius:3px;width:42px">` +
        config.typeOptions.map(o =>
          `<option value="${o.value}" ${item.type === o.value ? 'selected' : ''}>${o.label}</option>`
        ).join('') +
        `</select>`;
    }
    return `<div class="id-entry-row" data-index="${i}">
      ${typeHtml}
      <input type="text" class="input input-sm id-real" value="${escapeAttr(item.real || '')}" placeholder="${config.placeholderReal}">
      <span class="arrow" style="font-size:12px">&rarr;</span>
      <input type="text" class="input input-sm id-sub" value="${escapeAttr(item.substitute || '')}" placeholder="${config.placeholderSub}">
      <button class="btn-remove" title="Remove">&times;</button>
    </div>`;
  }).join('');

  // Bind remove buttons
  container.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.id-entry-row');
      if (container.querySelectorAll('.id-entry-row').length > 1) {
        row.remove();
      } else {
        // Clear instead of remove if it's the last row
        row.querySelectorAll('input').forEach(inp => inp.value = '');
      }
    });
  });
}

function loadIdentityForm() {
  const profile = profiles.find(p => p.id === currentProfileId);
  if (!profile) return;

  renderFieldList('names', profile.names || []);
  renderFieldList('emails', profile.emails || []);
  renderFieldList('usernames', profile.usernames || []);
  renderFieldList('hostnames', profile.hostnames || []);
  renderFieldList('phones', profile.phones || []);
  $('#idCatchAllEmail').value = profile.catchAllEmail || '';
  $('#profileActive').checked = profile.active ?? true;

  // Bind add buttons
  $$('.btn-add').forEach(btn => {
    // Remove old listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.replaceWith(newBtn);
    newBtn.addEventListener('click', () => {
      const field = newBtn.dataset.field;
      const config = FIELD_CONFIGS[field];
      const container = $(`#${config.container}`);
      const count = container.querySelectorAll('.id-entry-row').length;
      const tempDiv = document.createElement('div');
      let typeHtml = '';
      if (config.typeOptions) {
        // Alternate: if first row is 'first', next should be 'last', etc.
        const defaultType = count % 2 === 0 ? 'first' : 'last';
        typeHtml = `<select class="id-type-select" data-index="${count}" style="padding:3px 2px;font-size:10px;border:1px solid #e5e7eb;border-radius:3px;width:42px">` +
          config.typeOptions.map(o =>
            `<option value="${o.value}" ${o.value === defaultType ? 'selected' : ''}>${o.label}</option>`
          ).join('') +
          `</select>`;
      }
      tempDiv.innerHTML = `<div class="id-entry-row" data-index="${count}">
        ${typeHtml}
        <input type="text" class="input input-sm id-real" placeholder="${config.placeholderReal}">
        <span class="arrow" style="font-size:12px">&rarr;</span>
        <input type="text" class="input input-sm id-sub" placeholder="${config.placeholderSub}">
        <button class="btn-remove" title="Remove">&times;</button>
      </div>`;
      const row = tempDiv.firstElementChild;
      container.appendChild(row);
      row.querySelector('.btn-remove').addEventListener('click', () => {
        if (container.querySelectorAll('.id-entry-row').length > 1) row.remove();
        else row.querySelectorAll('input').forEach(inp => inp.value = '');
      });
      row.querySelector('.id-real').focus();
    });
  });
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Read entries from a dynamic field list
function readFieldEntries(fieldName) {
  const config = FIELD_CONFIGS[fieldName];
  const container = $(`#${config.container}`);
  if (!container) return [];

  const entries = [];
  container.querySelectorAll('.id-entry-row').forEach(row => {
    const real = row.querySelector('.id-real')?.value.trim() || '';
    const sub = row.querySelector('.id-sub')?.value.trim() || '';
    if (real && sub) {
      const entry = { real, substitute: sub };
      const typeSelect = row.querySelector('.id-type-select');
      if (typeSelect) entry.type = typeSelect.value;
      entries.push(entry);
    }
  });

  return entries;
}

async function saveIdentity() {
  const profileData = {
    names: readFieldEntries('names'),
    emails: readFieldEntries('emails'),
    usernames: readFieldEntries('usernames'),
    hostnames: readFieldEntries('hostnames'),
    phones: readFieldEntries('phones'),
    catchAllEmail: $('#idCatchAllEmail').value.trim(),
    emailDomains: [],
    enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
  };

  await Storage.updateProfile(currentProfileId, profileData);
  profiles = await Storage.getProfiles();
  identity = await Storage.getIdentity();
  checkFirstRun();

  // Flash save button
  const btn = $('#btnSaveIdentity');
  btn.textContent = 'Saved!';
  btn.style.background = '#059669';
  setTimeout(() => {
    btn.textContent = 'Save Identity';
    btn.style.background = '';
  }, 1500);
}

// --- First-Run Check ---
function checkFirstRun() {
  const hasNames = (identity.names || []).length > 0;
  const hasEmails = (identity.emails || []).length > 0 || !!identity.catchAllEmail;
  const hasUsernames = (identity.usernames || []).length > 0;
  const hasMappings = mappings.length > 0;

  // Show banner if nothing is configured at all
  const isConfigured = hasNames || hasEmails || hasUsernames || hasMappings;
  const banner = $('#firstRunBanner');
  banner.style.display = isConfigured ? 'none' : 'flex';

  // Also update the status dot — orange if unconfigured
  const dot = $('#statusDot');
  if (!isConfigured && settings.enabled) {
    dot.classList.add('off-site');
    dot.classList.remove('disabled');
  } else {
    dot.classList.remove('off-site');
  }
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

// --- Test Diff (Strip: real → fake) ---
function renderTestDiff() {
  const input = $('#testInput').value;
  const output = $('#diffOutput');
  const stats = $('#diffStats');

  if (!input) {
    output.innerHTML = '';
    stats.textContent = '';
    return;
  }

  const smartResult = SmartPatterns.substitute(input, identity);
  const explicitResult = SubstitutionEngine.substitute(smartResult.text, mappings);
  const secretResult = SecretScanner.redact(explicitResult.text);

  const allReplacements = [
    ...smartResult.replacements,
    ...explicitResult.replacements,
    ...secretResult.redactions,
  ];
  const finalText = secretResult.text;

  if (finalText === input && secretResult.warnings.length === 0) {
    output.textContent = input;
    stats.textContent = 'No substitutions detected';
    return;
  }

  let html = escapeHtml(finalText);

  // Highlight identity + explicit substitutions in green
  for (const r of [...smartResult.replacements, ...explicitResult.replacements]) {
    const escapedReplaced = escapeHtml(r.replaced);
    html = html.replace(
      escapedReplaced,
      `<span class="sub-highlight" title="Was: ${escapeHtml(r.original)} [${r.pattern || r.category}]">${escapedReplaced}</span>`
    );
  }
  // Highlight secret redactions in red
  for (const r of secretResult.redactions) {
    const escapedReplaced = escapeHtml(r.replaced);
    html = html.replace(
      escapedReplaced,
      `<span class="sub-highlight" style="background:#fee2e2;color:#dc2626" title="${escapeHtml(r.pattern)}">${escapedReplaced}</span>`
    );
  }
  output.innerHTML = html;

  const smartCount = smartResult.replacements.length;
  const explicitCount = explicitResult.replacements.length;
  const secretCount = secretResult.redactions.length;
  const warnCount = secretResult.warnings.length;
  const parts = [];
  if (smartCount > 0) parts.push(`${smartCount} smart`);
  if (explicitCount > 0) parts.push(`${explicitCount} explicit`);
  if (secretCount > 0) parts.push(`${secretCount} secrets redacted`);
  if (warnCount > 0) parts.push(`${warnCount} warnings`);
  stats.textContent = `${allReplacements.length} substitution${allReplacements.length !== 1 ? 's' : ''} (${parts.join(', ')})`;
}

// --- Reveal Diff (fake → real) ---
function renderRevealDiff() {
  const input = $('#revealInput').value;
  const output = $('#revealOutput');
  const stats = $('#revealStats');

  if (!input) {
    output.innerHTML = '';
    stats.textContent = '';
    return;
  }

  // Reverse: substitute → real using SmartPatterns reveal + explicit reveal
  let result = input;
  let totalCount = 0;

  // Reverse explicit mappings (substitute → real)
  const explicitRevealed = SubstitutionEngine.reveal(result, mappings);
  // Count explicit reveals
  for (const m of mappings) {
    if (!m.enabled || !m.substitute) continue;
    const regex = new RegExp(escapeRegex(m.substitute), m.caseSensitive ? 'g' : 'gi');
    const matches = result.match(regex);
    if (matches) totalCount += matches.length;
  }
  result = explicitRevealed;

  // Reverse smart patterns (all identity substitutes → real)
  const allSubs = gatherSmartSubstitutePairs(identity);
  for (const pair of allSubs) {
    const regex = new RegExp(escapeRegex(pair.substitute), 'gi');
    const matches = result.match(regex);
    if (matches) totalCount += matches.length;
    result = result.replace(regex, pair.real);
  }

  if (result === input) {
    output.textContent = input;
    stats.textContent = 'No substituted values found to reveal';
    return;
  }

  // Highlight revealed values
  let html = escapeHtml(result);
  for (const pair of [...allSubs, ...mappings.filter(m => m.enabled)]) {
    const real = pair.real;
    if (!real) continue;
    const escapedReal = escapeHtml(real);
    html = html.replace(
      new RegExp(escapeRegex(escapedReal), 'gi'),
      `<span class="sub-highlight" title="Was: ${escapeHtml(pair.substitute)}" style="background:#dbeafe;color:#1d4ed8">${escapedReal}</span>`
    );
  }
  output.innerHTML = html;
  stats.textContent = `${totalCount} value${totalCount !== 1 ? 's' : ''} revealed`;
}

// Gather all substitute → real pairs from identity for reveal
function gatherSmartSubstitutePairs(id) {
  const pairs = [];
  for (const e of (id.emails || [])) {
    if (e.substitute && e.real) pairs.push(e);
  }
  if (id.catchAllEmail) {
    pairs.push({ substitute: id.catchAllEmail, real: '[catch-all]' });
  }
  for (const n of (id.names || [])) {
    if (n.substitute && n.real) pairs.push(n);
  }
  for (const u of (id.usernames || [])) {
    if (u.substitute && u.real) pairs.push(u);
  }
  for (const h of (id.hostnames || [])) {
    if (h.substitute && h.real) pairs.push(h);
  }
  for (const p of (id.phones || [])) {
    if (p.substitute && p.real) pairs.push(p);
  }
  return pairs;
}

async function copyRevealedText() {
  const output = $('#revealOutput');
  const text = output.textContent;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const btn = $('#btnCopyRevealed');
    btn.textContent = 'Copied!';
    btn.style.background = '#059669';
    setTimeout(() => {
      btn.textContent = 'Copy to Clipboard';
      btn.style.background = '';
    }, 1500);
  } catch (e) {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// --- Identity Status ---
function updateIdentityStatus() {
  const el = $('#identityStatus');
  const missing = [];

  if (!(identity.names || []).some(n => n.type === 'first')) missing.push('first name');
  if (!(identity.names || []).some(n => n.type === 'last')) missing.push('last name');
  if ((identity.emails || []).length === 0 && !identity.catchAllEmail) missing.push('email');
  if ((identity.usernames || []).length === 0) missing.push('username');

  if (missing.length > 0) {
    el.textContent = `Identity missing: ${missing.join(', ')}. Go to the Identity tab to set up.`;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
