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
      if (tab.dataset.tab === 'test') {
        // Reload identity from storage in case it was just saved
        Storage.getIdentity().then((id) => {
          identity = id;
          updateIdentityStatus();
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

  const allReplacements = [...smartResult.replacements, ...explicitResult.replacements];
  const finalText = explicitResult.text;

  if (finalText === input) {
    output.textContent = input;
    stats.textContent = 'No substitutions detected';
    return;
  }

  let html = escapeHtml(finalText);
  for (const r of allReplacements) {
    const escapedReplaced = escapeHtml(r.replaced);
    html = html.replace(
      escapedReplaced,
      `<span class="sub-highlight" title="Was: ${escapeHtml(r.original)} [${r.pattern || r.category}]">${escapedReplaced}</span>`
    );
  }
  output.innerHTML = html;

  const smartCount = smartResult.replacements.length;
  const explicitCount = explicitResult.replacements.length;
  const parts = [];
  if (smartCount > 0) parts.push(`${smartCount} smart`);
  if (explicitCount > 0) parts.push(`${explicitCount} explicit`);
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
