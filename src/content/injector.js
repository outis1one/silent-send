/**
 * Silent Send - Content Script Injector
 *
 * This runs in Chrome's ISOLATED content script world, where it has
 * access to chrome.storage. It then injects the fetch-hooking code
 * into the MAIN page world so it can intercept the actual fetch() calls.
 *
 * Communication: page script <-> content script via window.postMessage
 */

'use strict';

// Load mappings and settings, then inject into page
async function init() {
  const result = await chrome.storage.local.get(['ss_mappings', 'ss_settings']);
  const mappings = result.ss_mappings || [];
  const settings = result.ss_settings || { enabled: true };

  // Inject the main interception script into the page's world
  const script = document.createElement('script');
  script.setAttribute('data-ss-config', JSON.stringify({ mappings, settings }));
  script.src = chrome.runtime.getURL('src/content/content.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  // Listen for substitution events from the page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'ss:substitution-performed') {
      chrome.runtime.sendMessage({
        type: 'substitution:performed',
        count: event.data.count,
        replacements: event.data.replacements,
      }).catch(() => {});
    }
  });

  // Forward storage changes to the page script
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.ss_mappings || changes.ss_settings) {
      window.postMessage({
        type: 'ss:config-updated',
        mappings: changes.ss_mappings?.newValue,
        settings: changes.ss_settings?.newValue,
      }, '*');
    }
  });

  // Listen for settings updates from popup via runtime messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'settings:updated') {
      window.postMessage({
        type: 'ss:config-updated',
        settings: message.settings,
      }, '*');
    }
  });
}

init();
