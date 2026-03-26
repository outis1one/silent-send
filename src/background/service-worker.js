/**
 * Silent Send - Background Service Worker
 *
 * Manages badge count, coordinates between popup and content scripts.
 * Injects content scripts on custom domains dynamically.
 * Uses `api` alias for cross-browser compatibility (Chrome + Firefox).
 */

import Storage from '../lib/storage.js';
import api from '../lib/browser-polyfill.js';

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

// --- Set initial badge state ---
api.runtime.onInstalled.addListener(() => {
  api.action.setBadgeBackgroundColor({ color: '#6b7280' });
});
