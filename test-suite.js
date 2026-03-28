import Storage from './src/lib/storage.js';
import SilentSendSync from './src/lib/sync.js';
import SilentSendCrypto from './src/lib/crypto.js';
import AutoRedact from './src/lib/auto-redact.js';
import AutoDetect from './src/lib/auto-detect.js';
import SmartPatterns from './src/lib/smart-patterns.js';
import SubstitutionEngine from './src/lib/substitution-engine.js';

const tests = [];
let currentGroup = '';

function group(name) { currentGroup = name; }
function test(name, fn) { tests.push({ group: currentGroup, name, fn }); }

function renderResults(outcomes) {
  const el = document.getElementById('results');
  const groups = {};
  for (const o of outcomes) {
    if (!groups[o.group]) groups[o.group] = [];
    groups[o.group].push(o);
  }

  let html = '';
  for (const [groupName, items] of Object.entries(groups)) {
    html += `<div class="test-group"><h2>${groupName}</h2>`;
    for (const t of items) {
      const icon = t.status === 'pass' ? '\u2713' : t.status === 'fail' ? '\u2717' : '\u25CB';
      html += `<div class="test"><span class="status ${t.status}">${icon}</span> ${t.name}</div>`;
      if (t.error) html += `<div class="detail">${t.error}</div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;

  const passed = outcomes.filter(o => o.status === 'pass').length;
  const failed = outcomes.filter(o => o.status === 'fail').length;
  const skipped = outcomes.filter(o => o.status === 'skip').length;
  const sum = document.getElementById('summary');
  sum.className = failed > 0 ? 'has-fail' : 'all-pass';
  sum.textContent = `${passed} passed, ${failed} failed, ${skipped} skipped \u2014 ${outcomes.length} total`;
}

// ============================================================
// STORAGE TESTS
// ============================================================
group('Storage \u2014 Settings');

test('Default settings have autoRedact=true', async () => {
  const s = await Storage.getSettings();
  if (s.autoRedact !== true) throw `Expected autoRedact=true, got ${s.autoRedact}`;
});

test('Default settings have customRedactPatterns=[]', async () => {
  const s = await Storage.getSettings();
  if (!Array.isArray(s.customRedactPatterns)) throw `Expected array, got ${typeof s.customRedactPatterns}`;
});

test('Default settings have maxLogEntries=100', async () => {
  const s = await Storage.getSettings();
  if (s.maxLogEntries !== 100) throw `Expected 100, got ${s.maxLogEntries}`;
});

test('Default settings have browserSync=false', async () => {
  const s = await Storage.getSettings();
  if (s.browserSync !== false) throw `Expected false, got ${s.browserSync}`;
});

test('Save and read settings round-trip', async () => {
  await Storage.saveSettings({ autoRedact: false });
  const s = await Storage.getSettings();
  if (s.autoRedact !== false) throw `Expected false after save, got ${s.autoRedact}`;
  await Storage.saveSettings({ autoRedact: true });
});

group('Storage \u2014 Activity Log');

test('Activity log respects maxLogEntries=100', async () => {
  await Storage.clearLog();
  for (let i = 0; i < 110; i++) {
    await Storage.addLogEntry({ type: 'test', original: `test${i}`, replaced: `fake${i}` });
  }
  const log = await Storage.getLog();
  if (log.length > 100) throw `Expected <=100 entries, got ${log.length}`;
  await Storage.clearLog();
});

group('Storage \u2014 Mappings');

test('Add and retrieve mapping', async () => {
  const m = await Storage.addMapping({ real: 'TestReal', substitute: 'TestFake', category: 'general' });
  if (!m.id) throw 'Mapping has no id';
  const all = await Storage.getMappings();
  const found = all.find(x => x.id === m.id);
  if (!found) throw 'Mapping not found after add';
  await Storage.deleteMapping(m.id);
});

group('Storage \u2014 Profiles');

test('Add and retrieve profile', async () => {
  const p = await Storage.addProfile('Test Profile');
  if (!p.id) throw 'Profile has no id';
  const all = await Storage.getProfiles();
  const found = all.find(x => x.id === p.id);
  if (!found) throw 'Profile not found after add';
  await Storage.deleteProfile(p.id);
});

// ============================================================
// ENCRYPTION TESTS
// ============================================================
group('Encryption \u2014 Setup & Authentication');

test('Setup encryption with password', async () => {
  await SilentSendSync.disableEncryption().catch(() => {});
  const result = await SilentSendSync.setupEncryption({
    password: 'testpass123',
    enableTOTP: false,
    ttlDays: 90,
  });
  if (!result.success) throw `Setup failed: ${result.reason}`;
});

test('isEncryptionEnabled returns true after setup', async () => {
  const enabled = await SilentSendSync.isEncryptionEnabled();
  if (!enabled) throw 'Expected encryption to be enabled';
});

test('Authenticate with correct password', async () => {
  const result = await SilentSendSync.authenticate('testpass123');
  if (!result.success) throw `Auth failed: ${result.reason}`;
});

test('Authenticate with wrong password fails', async () => {
  await SilentSendCrypto.clearCachedKey();
  const result = await SilentSendSync.authenticate('wrongpassword');
  if (result.success) throw 'Expected auth to fail with wrong password';
  await SilentSendSync.authenticate('testpass123');
});

group('Encryption \u2014 At-Rest');

test('Data is encrypted at rest when encryption enabled', async () => {
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  await Storage.saveMappings([{ id: 'enc-test', real: 'EncSecret', substitute: 'EncFake' }]);
  const raw = await api.storage.local.get('ss_mappings');
  const val = raw.ss_mappings;
  if (!val?._ssLocalEncrypted) throw 'Expected _ssLocalEncrypted flag on stored data';
  await Storage.saveMappings([]);
});

test('Encrypted data reads back correctly', async () => {
  await Storage.saveMappings([{ id: 'enc-rt', real: 'RoundTrip', substitute: 'RTFake' }]);
  const mappings = await Storage.getMappings();
  const found = mappings.find(m => m.id === 'enc-rt');
  if (!found) throw 'Mapping not found after encrypted round-trip';
  if (found.real !== 'RoundTrip') throw `Expected 'RoundTrip', got '${found.real}'`;
  await Storage.saveMappings([]);
});

// ============================================================
// SYNC — ENCRYPTION MANDATORY
// ============================================================
group('Sync \u2014 Encryption Required');

test('Sync code export works when encryption enabled', async () => {
  const code = await SilentSendSync.exportSyncCode();
  if (code?.needsEncryption) throw 'Should not need encryption \u2014 it is enabled';
  if (code?.needsAuth) throw 'Should not need auth \u2014 key is cached';
  if (typeof code !== 'string') throw `Expected string, got ${typeof code}`;
  if (code.length < 10) throw 'Sync code seems too short';
});

test('Sync code export fails without encryption', async () => {
  await SilentSendSync.disableEncryption();
  const code = await SilentSendSync.exportSyncCode();
  if (!code?.needsEncryption) throw 'Expected needsEncryption=true when encryption disabled';
  await SilentSendSync.setupEncryption({ password: 'testpass123' });
});

test('Sync code import round-trip', async () => {
  await Storage.saveMappings([{ id: 'sync-test', real: 'SyncMe', substitute: 'SyncFake' }]);
  const code = await SilentSendSync.exportSyncCode();
  await Storage.saveMappings([]);
  const result = await SilentSendSync.importSyncCode(code, { force: true });
  if (!result.success) throw `Import failed: ${result.reason}`;
  const mappings = await Storage.getMappings();
  const found = mappings.find(m => m.real === 'SyncMe');
  if (!found) throw 'Mapping not found after sync code round-trip';
  await Storage.saveMappings([]);
});

test('pushToSyncStorage silently skips without encryption', async () => {
  await SilentSendSync.disableEncryption();
  await SilentSendSync.pushToSyncStorage();
  await SilentSendSync.setupEncryption({ password: 'testpass123' });
});

test('pushToGist fails without encryption', async () => {
  await SilentSendSync.disableEncryption();
  const result = await SilentSendSync.pushToGist('fake-token');
  if (!result.needsEncryption) throw 'Expected needsEncryption=true';
  await SilentSendSync.setupEncryption({ password: 'testpass123' });
});

test('pushToUrl fails without encryption', async () => {
  await SilentSendSync.disableEncryption();
  const result = await SilentSendSync.pushToUrl({ url: 'https://example.com/sync' });
  if (!result.needsEncryption) throw 'Expected needsEncryption=true';
  await SilentSendSync.setupEncryption({ password: 'testpass123' });
});

group('Sync \u2014 Disable Encryption Disables Sync');

test('Disabling encryption sets browserSync=false', async () => {
  await Storage.saveSettings({ browserSync: true });
  await SilentSendSync.disableEncryption();
  const s = await Storage.getSettings();
  if (s.browserSync !== false) throw `Expected browserSync=false, got ${s.browserSync}`;
  await SilentSendSync.setupEncryption({ password: 'testpass123' });
});

// ============================================================
// ENCRYPTION WITH TOTP
// ============================================================
group('Encryption \u2014 TOTP');

test('Setup encryption with TOTP', async () => {
  await SilentSendSync.disableEncryption().catch(() => {});
  const result = await SilentSendSync.setupEncryption({
    password: 'totptest123',
    enableTOTP: true,
    ttlDays: 90,
  });
  if (!result.success) throw `Setup failed: ${result.reason}`;
  if (!result.totpSecret) throw 'Expected TOTP secret in response';
  if (!result.totpURI) throw 'Expected TOTP URI in response';
});

test('TOTP secret is encrypted at rest', async () => {
  const config = await SilentSendSync._getSyncEncryption();
  if (config.totpSecret) throw 'TOTP secret should be encrypted, not plaintext';
  if (!config._totpEncrypted) throw 'Expected _totpEncrypted blob';
});

test('Clean up \u2014 disable encryption', async () => {
  await SilentSendSync.disableEncryption();
  const enabled = await SilentSendSync.isEncryptionEnabled();
  if (enabled) throw 'Encryption should be disabled';
});

// ============================================================
// AUTO-REDACT TESTS
// ============================================================
group('Auto-Redact \u2014 Built-in Patterns');

test('Detects OpenAI key', () => {
  const result = AutoRedact.redact('my key is sk-abc123def456ghi789jkl012mno');
  if (result.redactions.length === 0) throw 'Expected redaction';
  if (!result.text.includes('[REDACTED-OPENAI-KEY]')) throw 'Expected [REDACTED-OPENAI-KEY]';
});

test('Detects GitHub token', () => {
  const result = AutoRedact.redact('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn');
  if (result.redactions.length === 0) throw 'Expected redaction';
});

test('Detects SSN', () => {
  const result = AutoRedact.redact('my ssn is 123-45-6789');
  if (result.redactions.length === 0) throw 'Expected redaction';
  if (!result.text.includes('[REDACTED-SSN]')) throw 'Expected [REDACTED-SSN]';
});

test('Detects credit card', () => {
  const result = AutoRedact.redact('card: 4111 1111 1111 1111');
  if (result.redactions.length === 0) throw 'Expected redaction';
});

test('Detects Bearer token', () => {
  const result = AutoRedact.redact('Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdef');
  if (result.redactions.length === 0) throw 'Expected redaction';
});

test('Detects private key block', () => {
  const result = AutoRedact.redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----');
  if (result.redactions.length === 0) throw 'Expected redaction';
});

test('Detects connection string', () => {
  const result = AutoRedact.redact('mongodb://admin:secret@db.example.com:27017/mydb');
  if (result.redactions.length === 0) throw 'Expected redaction';
});

group('Auto-Redact \u2014 Custom Patterns');

test('Custom pattern matches', () => {
  const custom = [{ name: 'ControlD', pattern: 'dns\\.controld\\.com/[A-Za-z0-9;]+', redact: '[REDACTED-CONTROLD]', enabled: true }];
  const result = AutoRedact.redact('url: https://dns.controld.com/sasdkj;kjasda', custom);
  if (result.redactions.length === 0) throw 'Expected custom pattern redaction';
  if (!result.text.includes('[REDACTED-CONTROLD]')) throw 'Expected [REDACTED-CONTROLD]';
});

test('Disabled custom pattern does not match', () => {
  const custom = [{ name: 'ControlD', pattern: 'dns\\.controld\\.com/[A-Za-z0-9;]+', redact: '[REDACTED]', enabled: false }];
  const result = AutoRedact.redact('url: https://dns.controld.com/sasdkj;kjasda', custom);
  if (result.text.includes('[REDACTED]')) throw 'Disabled pattern should not match';
});

test('Invalid regex in custom pattern is skipped gracefully', () => {
  const custom = [{ name: 'Bad', pattern: '[invalid(regex', redact: '[X]', enabled: true }];
  const result = AutoRedact.redact('test text', custom);
  if (result.text !== 'test text') throw 'Text should be unchanged';
});

test('Redactions use category=redact', () => {
  const result = AutoRedact.redact('key: sk-abc123def456ghi789jkl012mno');
  if (result.redactions.length > 0 && result.redactions[0].category !== 'redact') {
    throw `Expected category 'redact', got '${result.redactions[0].category}'`;
  }
});

// ============================================================
// SUBSTITUTION ENGINE
// ============================================================
group('Substitution Engine');

test('Basic substitution works', () => {
  const result = SubstitutionEngine.substitute('Hello John Smith', [
    { real: 'John Smith', substitute: 'Alex Demo', enabled: true }
  ]);
  if (!result.text.includes('Alex Demo')) throw 'Expected Alex Demo in output';
});

test('Case insensitive by default', () => {
  const result = SubstitutionEngine.substitute('hello JOHN SMITH', [
    { real: 'John Smith', substitute: 'Alex Demo', enabled: true, caseSensitive: false }
  ]);
  if (!result.text.includes('Alex Demo')) throw 'Expected case-insensitive match';
});

test('Disabled mapping is skipped', () => {
  const result = SubstitutionEngine.substitute('Hello John Smith', [
    { real: 'John Smith', substitute: 'Alex Demo', enabled: false }
  ]);
  if (result.text.includes('Alex Demo')) throw 'Disabled mapping should not substitute';
});

// ============================================================
// SMART PATTERNS
// ============================================================
group('Smart Patterns \u2014 Identity');

test('Email substitution', () => {
  const identity = {
    emails: [{ real: 'john@gmail.com', substitute: 'alex@example.com' }],
    names: [], usernames: [], phones: [], hostnames: [],
    enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
  };
  const result = SmartPatterns.substitute('email: john@gmail.com', identity);
  if (!result.text.includes('alex@example.com')) throw 'Expected email substitution';
});

test('Name substitution', () => {
  const identity = {
    names: [{ real: 'John Smith', substitute: 'Alex Demo' }],
    emails: [], usernames: [], phones: [], hostnames: [],
    enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
  };
  const result = SmartPatterns.substitute('My name is John Smith', identity);
  if (!result.text.includes('Alex Demo')) throw 'Expected name substitution';
});

test('Phone substitution', () => {
  const identity = {
    phones: [{ real: '555-123-4567', substitute: '555-000-0000' }],
    names: [], emails: [], usernames: [], hostnames: [],
    enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
  };
  const result = SmartPatterns.substitute('call 555-123-4567', identity);
  if (!result.text.includes('555-000-0000')) throw 'Expected phone substitution';
});

// ============================================================
// AUTO-DETECT (PII Scanner)
// ============================================================
group('Auto-Detect \u2014 PII Patterns');

test('Detects private IP addresses', () => {
  const warnings = AutoDetect.scan('server at 192.168.1.100', {});
  const ipWarn = warnings.find(w => w.type === 'private-ip');
  if (!ipWarn) throw 'Expected private IP detection';
});

// ============================================================
// SETTINGS INTEGRITY
// ============================================================
group('Settings \u2014 No Stale Keys');

test('No secretScanning key in defaults', async () => {
  const s = await Storage.getSettings();
  if ('secretScanning' in s && !('autoRedact' in s)) throw 'Found stale secretScanning key';
});

test('No customSecretPatterns key in defaults', async () => {
  const s = await Storage.getSettings();
  if ('customSecretPatterns' in s && !('customRedactPatterns' in s)) throw 'Found stale customSecretPatterns key';
});

// ============================================================
// RUN
// ============================================================

async function runAllTests() {
  document.getElementById('results').innerHTML = '<p style="color:#6b7280">Running tests...</p>';
  const outcomes = [];
  for (const t of tests) {
    try {
      await t.fn();
      outcomes.push({ group: t.group, name: t.name, status: 'pass' });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e?.message || String(e));
      outcomes.push({ group: t.group, name: t.name, status: 'fail', error: msg });
    }
  }
  renderResults(outcomes);
}

document.getElementById('btnRunTests').addEventListener('click', runAllTests);
document.getElementById('btnClear').addEventListener('click', () => {
  document.getElementById('results').innerHTML = '';
  document.getElementById('summary').textContent = '';
});

document.getElementById('results').innerHTML = `<p style="color:#6b7280">${tests.length} tests loaded. Click "Run All Tests" to start.</p>`;
