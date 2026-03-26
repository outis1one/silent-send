/**
 * Silent Send - Content Script Injector
 *
 * Runs in the ISOLATED content script world, where it has access to
 * browser/chrome.storage. Injects the fetch-hooking code into the
 * MAIN page world so it can intercept the actual fetch() calls.
 *
 * Communication: page script <-> content script via window.postMessage
 */

(function () {
  'use strict';

  // Prevent double-injection on custom domains
  if (window.__silentSendInjected) return;
  window.__silentSendInjected = true;

  // Merge active profiles into flat identity object
  function mergeProfiles(data) {
    const profiles = data?.profiles || [];
    const active = profiles.filter(p => p.active);

    if (active.length === 0) {
      // Legacy format: data IS the flat identity (pre-profile migration)
      if (data && (data.names || data.emails || data.usernames)) return data;
      return { emails: [], names: [], usernames: [], hostnames: [], phones: [],
        catchAllEmail: '', emailDomains: [],
        enabled: { emails: true, names: true, usernames: true, phones: true, paths: true } };
    }

    const merged = {
      emails: [], names: [], usernames: [], hostnames: [], phones: [],
      catchAllEmail: '', emailDomains: [],
      enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
    };

    for (const p of active) {
      merged.emails.push(...(p.emails || []));
      merged.names.push(...(p.names || []));
      merged.usernames.push(...(p.usernames || []));
      merged.hostnames.push(...(p.hostnames || []));
      merged.phones.push(...(p.phones || []));
      if (p.catchAllEmail && !merged.catchAllEmail) merged.catchAllEmail = p.catchAllEmail;
      merged.emailDomains.push(...(p.emailDomains || []));
    }

    return merged;
  }

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
    const settings = result.ss_settings || { enabled: true };

    // Merge active profiles into a flat identity object for the content script
    const identityData = result.ss_identity || {};
    const identity = mergeProfiles(identityData);

    // Inject the main interception script into the page's world
    const script = document.createElement('script');
    script.setAttribute('data-ss-config', JSON.stringify({ mappings, identity, settings }));
    script.src = api.runtime.getURL('src/content/content.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    // Listen for substitution events from the page script
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'ss:substitution-performed') {
        // Try to notify background for badge update
        api.runtime.sendMessage({
          type: 'substitution:performed',
          count: event.data.count,
          replacements: event.data.replacements,
        }).catch(() => {});

        // Also log directly from the injector (content script world)
        // in case the background worker is asleep
        const replacements = event.data.replacements || [];
        for (const r of replacements) {
          const log = (await api.storage.local.get('ss_activity_log')).ss_activity_log || [];
          log.unshift({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            type: 'substitution',
            direction: 'outbound',
            original: r.original,
            replaced: r.replaced,
            category: r.category || 'general',
            pattern: r.pattern || '',
            url: location.href,
          });
          // Trim
          if (log.length > 200) log.length = 200;
          await api.storage.local.set({ ss_activity_log: log });
        }
      }
    });

    // Forward storage changes to the page script (merge profiles before sending)
    api.storage.onChanged.addListener((changes) => {
      if (changes.ss_mappings || changes.ss_identity || changes.ss_settings) {
        const msg = { type: 'ss:config-updated' };
        if (changes.ss_mappings) msg.mappings = changes.ss_mappings.newValue;
        if (changes.ss_identity) msg.identity = mergeProfiles(changes.ss_identity.newValue);
        if (changes.ss_settings) msg.settings = changes.ss_settings.newValue;
        window.postMessage(msg, '*');
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

    // Storage bridge — lets page world script read/write storage
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;

      if (event.data?.type === 'ss:storage-get') {
        const result = await api.storage.local.get(event.data.key);
        window.postMessage({
          type: 'ss:storage-result',
          id: event.data.id,
          value: result[event.data.key] || null,
        }, '*');
      }

      if (event.data?.type === 'ss:storage-set') {
        await api.storage.local.set({ [event.data.key]: event.data.value });
      }
    });
  }

  init();
})();
