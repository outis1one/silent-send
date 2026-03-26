/**
 * Silent Send - Background Service Worker
 *
 * Manages badge count, coordinates between popup and content scripts.
 * Injects content scripts on custom domains dynamically.
 * Uses `api` alias for cross-browser compatibility (Chrome + Firefox).
 */

import Storage from '../lib/storage.js';
import SilentSendSync from '../lib/sync.js';
import OrgPolicy from '../lib/org-policy.js';
import TamperGuard from '../lib/tamper-guard.js';
import api from '../lib/browser-polyfill.js';

// --- Alarm names ---
const AUTO_SYNC_ALARM = 'ss-auto-sync';
const ORG_POLICY_ALARM = 'ss-org-policy';

// Track substitution counts per tab
const tabCounts = new Map();

// Built-in URL patterns
const BUILTIN_URL_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://grok.x.ai/*',
  'https://x.com/i/grok*',
  'https://gemini.google.com/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
];

// --- Badge Management ---

function updateBadge(tabId) {
  const count = tabCounts.get(tabId) || 0;
  const text = count > 0 ? String(count) : '';

  api.action.setBadgeText({ text, tabId });
  api.action.setBadgeBackgroundColor({ color: count > 0 ? '#10b981' : '#6b7280', tabId });
}

// Reset count when tab navigates
api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    tabCounts.set(tabId, 0);
    updateBadge(tabId);
  }

  // Inject content script on custom domains when page loads
  if (changeInfo.status === 'complete' && tab.url) {
    await injectOnCustomDomain(tabId, tab.url);
  }
});

// Cleanup when tab closes
api.tabs.onRemoved.addListener((tabId) => {
  tabCounts.delete(tabId);
});

// --- Dynamic injection for custom domains ---

async function injectOnCustomDomain(tabId, tabUrl) {
  const settings = await Storage.getSettings();
  const customDomains = settings.customDomains || [];
  if (customDomains.length === 0) return;

  const matches = customDomains.some((domain) => tabUrl.startsWith(domain));
  if (!matches) return;

  // Check if already injected (avoid double-injection)
  try {
    const results = await api.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__silentSendInjected,
    });
    if (results?.[0]?.result) return;
  } catch (e) {
    // Permission denied — user hasn't granted access to this domain
    return;
  }

  // Inject CSS
  try {
    await api.scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content.css'],
    });
  } catch (e) { /* non-fatal */ }

  // Inject content script
  try {
    await api.scripting.executeScript({
      target: { tabId },
      files: ['src/content/injector.js'],
    });
  } catch (e) {
    console.warn('[Silent Send] Failed to inject on custom domain:', e);
  }
}

// --- Message Handling ---

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true; // async response
  }
});

const messageHandlers = {
  async 'substitution:performed'(message, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    const current = tabCounts.get(tabId) || 0;
    tabCounts.set(tabId, current + message.count);
    updateBadge(tabId);

    // Log each replacement
    for (const replacement of message.replacements) {
      await Storage.addLogEntry({
        type: 'substitution',
        direction: 'outbound',
        original: replacement.original,
        replaced: replacement.replaced,
        category: replacement.category,
        url: sender.tab?.url || '',
      });
    }
  },

  async 'get:mappings'(_message, _sender, sendResponse) {
    const mappings = await Storage.getMappings();
    sendResponse({ mappings });
  },

  async 'get:settings'(_message, _sender, sendResponse) {
    const settings = await Storage.getSettings();
    sendResponse({ settings });
  },

  async 'get:log'(_message, _sender, sendResponse) {
    const log = await Storage.getLog();
    sendResponse({ log });
  },

  async 'get:tab-count'(message, sender, sendResponse) {
    const tabId = message.tabId || sender.tab?.id;
    sendResponse({ count: tabCounts.get(tabId) || 0 });
  },

  async 'sync:notification-seen'() {
    // Options page opened — clear the sync badge and pending notification flag
    await api.storage.local.remove('ss_sync_notification');
    api.action.setBadgeText({ text: '' });
    api.action.setBadgeBackgroundColor({ color: '#6b7280' });
  },

  async 'get:locked-state'(_message, _sender, sendResponse) {
    const locked = await Storage.isLocked();
    sendResponse({ locked });
  },

  async 'vault:unlocked'() {
    // User unlocked the vault — clear the LOCK badge and refresh icon
    api.action.setBadgeText({ text: '' });
    const settings = await Storage.getSettings();
    await updateIcon(settings);

    // Now that we're unlocked, try syncing
    if (settings.browserSync) {
      await SilentSendSync.pullFromSyncStorage();
    }

    // Read decrypted data via Storage module and send to all content scripts
    const mappings = await Storage.getMappings();
    const identity = await Storage.getIdentity();

    const allPatterns = [...BUILTIN_URL_PATTERNS];
    const customDomains = settings.customDomains || [];
    for (const domain of customDomains) {
      allPatterns.push(domain + '/*');
    }
    for (const urlPattern of allPatterns) {
      const tabs = await api.tabs.query({ url: urlPattern }).catch(() => []);
      for (const tab of tabs) {
        api.tabs.sendMessage(tab.id, {
          type: 'vault:unlocked',
          mappings,
          identity,
          settings,
        }).catch(() => {});
      }
    }
  },

  async 'update:settings'(message) {
    await Storage.saveSettings(message.settings);

    // Build list of all URL patterns (built-in + custom)
    const allPatterns = [...BUILTIN_URL_PATTERNS];
    const customDomains = message.settings.customDomains || [];
    for (const domain of customDomains) {
      allPatterns.push(domain + '/*');
    }

    // Broadcast to content scripts
    for (const urlPattern of allPatterns) {
      const tabs = await api.tabs.query({ url: urlPattern }).catch(() => []);
      for (const tab of tabs) {
        api.tabs.sendMessage(tab.id, {
          type: 'settings:updated',
          settings: message.settings,
        }).catch(() => {});
      }
    }
  },
};

// --- Keyboard Shortcuts ---
api.commands.onCommand.addListener(async (command) => {
  const settings = await Storage.getSettings();

  if (command === 'toggle-reveal') {
    settings.revealMode = !settings.revealMode;
    await Storage.saveSettings({ revealMode: settings.revealMode });

    broadcastSettings(settings);
    await updateIcon(settings);

    // Flash badge text briefly
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      api.action.setBadgeText({ text: settings.revealMode ? 'EYE' : '', tabId: tab.id });
      api.action.setBadgeBackgroundColor({
        color: settings.revealMode ? '#1d4ed8' : '#6b7280',
        tabId: tab.id,
      });
      if (!settings.revealMode) {
        setTimeout(() => updateBadge(tab.id), 1500);
      }
    }
  }

  if (command === 'toggle-enabled') {
    settings.enabled = !settings.enabled;
    await Storage.saveSettings({ enabled: settings.enabled });

    broadcastSettings(settings);
    await updateIcon(settings);

    // Flash badge text briefly
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      api.action.setBadgeText({ text: settings.enabled ? 'ON' : 'OFF', tabId: tab.id });
      api.action.setBadgeBackgroundColor({
        color: settings.enabled ? '#10b981' : '#dc2626',
        tabId: tab.id,
      });
      setTimeout(() => updateBadge(tab.id), 1500);
    }
  }
});

async function broadcastSettings(settings) {
  const allPatterns = [...BUILTIN_URL_PATTERNS];
  const customDomains = settings.customDomains || [];
  for (const domain of customDomains) {
    allPatterns.push(domain + '/*');
  }
  for (const urlPattern of allPatterns) {
    const tabs = await api.tabs.query({ url: urlPattern }).catch(() => []);
    for (const tab of tabs) {
      api.tabs.sendMessage(tab.id, {
        type: 'settings:updated',
        settings,
      }).catch(() => {});
    }
  }
}

// --- Dynamic Icon Colors ---
// Green = active, Blue = reveal mode, Red = disabled, Gray = unconfigured

function generateIcon(color, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Rounded rect background
  const r = size * 0.19;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // "SS" text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size * 0.44}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SS', size / 2, size / 2 + size * 0.03);

  return ctx.getImageData(0, 0, size, size);
}

async function updateIcon(settings) {
  // Check if identity is configured
  const identity = await Storage.getIdentity();
  const mappings = await Storage.getMappings();
  const configured = mappings.length > 0 ||
    (identity.emails || []).length > 0 ||
    (identity.names || []).length > 0 ||
    (identity.usernames || []).length > 0 ||
    !!identity.catchAllEmail;

  let color;
  if (!settings.enabled) {
    color = '#dc2626'; // red — disabled
  } else if (!configured) {
    color = '#9ca3af'; // gray — not configured, effectively disabled
  } else if (settings.revealMode) {
    color = '#1d4ed8'; // blue — reveal mode
  } else {
    color = '#111111'; // dark — normal active
  }

  try {
    const imageData = {
      16: generateIcon(color, 16),
      32: generateIcon(color, 32),
      48: generateIcon(color, 48),
    };
    await api.action.setIcon({ imageData });
  } catch (e) {
    // OffscreenCanvas may not be available in all contexts
  }
}

// Update icon when settings, identity, or mappings change; push to sync storage if enabled
api.storage.onChanged.addListener(async (changes, areaName) => {
  if (changes.ss_settings || changes.ss_identity || changes.ss_mappings) {
    const settings = await Storage.getSettings();
    await updateIcon(settings);

    // Push to browser.storage.sync when local data changes (same-browser cross-device)
    if (areaName === 'local' && settings.browserSync) {
      await SilentSendSync.pushToSyncStorage();
    }
  }

  // When a sync operation applied new data, show badge + notification
  if (areaName === 'local' && changes.ss_sync_notification?.newValue) {
    const notif = changes.ss_sync_notification.newValue;
    const sourceLabel = {
      'file': 'sync folder',
      'browser-sync': 'browser account sync',
      'code': 'sync code import',
    }[notif.source] || 'sync';

    // Purple badge — persists until Options is opened
    api.action.setBadgeText({ text: 'SYN' });
    api.action.setBadgeBackgroundColor({ color: '#7c3aed' });

    // Desktop notification
    try {
      api.notifications.create('ss-sync-applied', {
        type: 'basic',
        iconUrl: 'icons/icon48.svg',
        title: 'Silent Send — Settings Synced',
        message: `Settings updated via ${sourceLabel}. Open Options to review.`,
        priority: 1,
      });
    } catch (e) {
      // Notifications permission not granted — badge is still visible
    }
  }

  // When sync storage changes (another device pushed new data), pull it into local
  if (areaName === 'sync' && (changes.ss_sync_meta || Object.keys(changes).some(k => k.startsWith('ss_sync_chunk_')))) {
    const settings = await Storage.getSettings();
    if (settings.browserSync) {
      await SilentSendSync.pullFromSyncStorage();
    }
  }
});

// Clicking a sync notification opens the Options page
api.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'ss-sync-applied') {
    api.runtime.openOptionsPage();
    api.notifications.clear(notificationId);
  }
});

// --- Alarms — background polling (MV3-safe, survives service worker restarts) ---

async function setupAutoSyncAlarm() {
  const config = await SilentSendSync.getAutoSyncConfig();
  if (config?.enabled) {
    api.alarms.create(AUTO_SYNC_ALARM, {
      periodInMinutes: config.interval || 15,
    });
  } else {
    api.alarms.clear(AUTO_SYNC_ALARM).catch(() => {});
  }
}

async function setupOrgPolicyAlarm() {
  const inOrg = await OrgPolicy.isInOrg();
  if (inOrg) {
    api.alarms.create(ORG_POLICY_ALARM, { periodInMinutes: 60 });
  } else {
    api.alarms.clear(ORG_POLICY_ALARM).catch(() => {});
  }
}

api.alarms.onAlarm.addListener(async (alarm) => {
  // Skip if locked
  const locked = await Storage.isLocked();
  if (locked) return;

  if (alarm.name === AUTO_SYNC_ALARM) {
    const result = await SilentSendSync.performAutoSync();
    if (result.pulled) {
      console.log('[Silent Send] Auto-sync pulled new data');
    }
    if (result.error) {
      console.warn('[Silent Send] Auto-sync error:', result.error);
    }
  }

  if (alarm.name === ORG_POLICY_ALARM) {
    const result = await OrgPolicy.fetchPolicy();
    if (result.updated) {
      console.log('[Silent Send] Org policy updated to version', result.version);
      // Notify content scripts of potential new mappings
      broadcastSettings(await Storage.getSettings());
    }
  }
});

// --- Tamper guard message handlers ---
const tamperHandlers = {
  async 'tamper:check-action'(message, _sender, sendResponse) {
    const result = await TamperGuard.requireAuth(message.action, message.adminPassword);
    sendResponse(result);
  },

  async 'tamper:is-enabled'(_message, _sender, sendResponse) {
    const enabled = await TamperGuard.isEnabled();
    sendResponse({ enabled });
  },
};

// Add tamper handlers to main message handler
const origHandler = api.runtime.onMessage._listeners?.[0];
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = tamperHandlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true;
  }
});

// --- Set initial state ---
api.runtime.onInstalled.addListener(async () => {
  api.action.setBadgeBackgroundColor({ color: '#6b7280' });
  const settings = await Storage.getSettings();
  await updateIcon(settings);
  // Set up alarms on install
  await setupAutoSyncAlarm();
  await setupOrgPolicyAlarm();
});

// Also set icon on startup (service worker wake) + pull any newer sync data
(async () => {
  const settings = await Storage.getSettings();
  await updateIcon(settings);

  // Check if extension is locked (encrypted data, no cached key)
  const locked = await Storage.isLocked();
  if (locked) {
    api.action.setBadgeText({ text: 'LOCK' });
    api.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return; // don't try to sync while locked
  }

  // Restore the SYN badge if the user hasn't opened Options since the last sync
  const stored = await api.storage.local.get('ss_sync_notification');
  if (stored.ss_sync_notification) {
    api.action.setBadgeText({ text: 'SYN' });
    api.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  }

  if (settings.browserSync) {
    await SilentSendSync.pullFromSyncStorage();
  }

  // Set up periodic alarms
  await setupAutoSyncAlarm();
  await setupOrgPolicyAlarm();
})();
