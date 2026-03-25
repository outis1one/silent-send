/**
 * Silent Send - Content Script Injector
 *
 * Runs in the ISOLATED content script world, where it has access to
 * browser/chrome.storage. Injects the fetch-hooking code into the
 * MAIN page world so it can intercept the actual fetch() calls.
 *
 * Communication: page script <-> content script via window.postMessage
 */

'use strict';

// Cross-browser API
const api =
  typeof browser !== 'undefined' && browser.runtime
    ? browser
    : typeof chrome !== 'undefined'
      ? chrome
      : null;

// Load mappings and settings, then inject into page
async function init() {
  const result = await api.storage.local.get(['ss_mappings', 'ss_identity', 'ss_settings']);
  const mappings = result.ss_mappings || [];
  const identity = result.ss_identity || {};
  const settings = result.ss_settings || { enabled: true };

  // Inject the main interception script into the page's world
  const script = document.createElement('script');
  script.setAttribute('data-ss-config', JSON.stringify({ mappings, identity, settings }));
  script.src = api.runtime.getURL('src/content/content.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  // Listen for substitution events from the page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'ss:substitution-performed') {
      api.runtime.sendMessage({
        type: 'substitution:performed',
        count: event.data.count,
        replacements: event.data.replacements,
      }).catch(() => {});
    }
  });

  // Forward storage changes to the page script
  api.storage.onChanged.addListener((changes) => {
    if (changes.ss_mappings || changes.ss_identity || changes.ss_settings) {
      window.postMessage({
        type: 'ss:config-updated',
        mappings: changes.ss_mappings?.newValue,
        identity: changes.ss_identity?.newValue,
        settings: changes.ss_settings?.newValue,
      }, '*');
    }
  });

  // Listen for settings updates from popup via runtime messages
  api.runtime.onMessage.addListener((message) => {
    if (message.type === 'settings:updated') {
      window.postMessage({
        type: 'ss:config-updated',
        settings: message.settings,
      }, '*');
    }
  });
}

init();
