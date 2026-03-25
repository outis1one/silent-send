/**
 * Silent Send - Page World Script
 *
 * Runs in the MAIN page world (injected by injector.js) so it can
 * hook the real fetch() and XMLHttpRequest used by Claude.ai.
 *
 * Communicates back to the content script via window.postMessage.
 */

(function () {
  'use strict';

  // ============================================================
  // Load config from the injector script's data attribute
  // ============================================================
  let mappings = [];
  let settings = { enabled: true, revealMode: false, showHighlights: false };

  try {
    const configEl = document.querySelector('script[data-ss-config]');
    if (configEl) {
      const config = JSON.parse(configEl.getAttribute('data-ss-config'));
      mappings = config.mappings || [];
      settings = { ...settings, ...(config.settings || {}) };
    }
  } catch (e) {
    console.warn('[Silent Send] Failed to parse initial config:', e);
  }

  // Listen for config updates from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'ss:config-updated') {
      if (event.data.mappings) mappings = event.data.mappings;
      if (event.data.settings) settings = { ...settings, ...event.data.settings };
    }
  });

  // ============================================================
  // Substitution Engine (inline — no module imports in page world)
  // ============================================================
  function substitute(text, maps) {
    const replacements = [];
    let result = text;
    const sorted = [...maps].sort((a, b) => b.real.length - a.real.length);

    for (const m of sorted) {
      if (!m.enabled || !m.real || !m.substitute) continue;
      const escaped = m.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, m.caseSensitive ? 'g' : 'gi');
      let match;
      while ((match = regex.exec(result)) !== null) {
        replacements.push({
          original: match[0],
          replaced: m.substitute,
          category: m.category || 'general',
        });
      }
      result = result.replace(regex, m.substitute);
    }
    return { text: result, replacements };
  }

  function reveal(text, maps) {
    let result = text;
    const sorted = [...maps].sort((a, b) => b.substitute.length - a.substitute.length);
    for (const m of sorted) {
      if (!m.enabled || !m.real || !m.substitute) continue;
      const escaped = m.substitute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, m.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, m.real);
    }
    return result;
  }

  // ============================================================
  // Notify content script of substitutions (for badge + logging)
  // ============================================================
  function notifySubstitutions(replacements) {
    window.postMessage({
      type: 'ss:substitution-performed',
      count: replacements.length,
      replacements,
    }, '*');
  }

  // ============================================================
  // Process a JSON body — handles all known Claude API shapes
  // ============================================================
  function processBody(body) {
    let modified = false;
    const allReplacements = [];

    // Shape 1: { prompt: "..." }
    if (typeof body.prompt === 'string') {
      const r = substitute(body.prompt, mappings);
      if (r.replacements.length > 0) {
        body.prompt = r.text;
        allReplacements.push(...r.replacements);
        modified = true;
      }
    }

    // Shape 2: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(body.content)) {
      for (let i = 0; i < body.content.length; i++) {
        const item = body.content[i];
        if (item.type === 'text' && typeof item.text === 'string') {
          const r = substitute(item.text, mappings);
          if (r.replacements.length > 0) {
            body.content[i] = { ...item, text: r.text };
            allReplacements.push(...r.replacements);
            modified = true;
          }
        }
      }
    }

    // Shape 3: { messages: [{ role: "user", content: "..." }] }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role !== 'user' && msg.role !== 'human') continue;

        if (typeof msg.content === 'string') {
          const r = substitute(msg.content, mappings);
          if (r.replacements.length > 0) {
            msg.content = r.text;
            allReplacements.push(...r.replacements);
            modified = true;
          }
        }

        if (Array.isArray(msg.content)) {
          for (let j = 0; j < msg.content.length; j++) {
            if (msg.content[j].type === 'text') {
              const r = substitute(msg.content[j].text, mappings);
              if (r.replacements.length > 0) {
                msg.content[j] = { ...msg.content[j], text: r.text };
                allReplacements.push(...r.replacements);
                modified = true;
              }
            }
          }
        }
      }
    }

    return { modified, replacements: allReplacements };
  }

  // ============================================================
  // Fetch Interception
  // ============================================================
  const originalFetch = window.fetch;

  window.fetch = async function (url, options) {
    if (!settings.enabled || mappings.length === 0) {
      return originalFetch.call(this, url, options);
    }

    const urlStr = typeof url === 'string' ? url : url?.url || '';
    const isTargetApi =
      urlStr.includes('/api/organizations/') &&
      (urlStr.includes('/chat_conversations/') ||
        urlStr.includes('/completion') ||
        urlStr.includes('/messages'));

    if (isTargetApi && options?.body && typeof options.body === 'string') {
      try {
        const body = JSON.parse(options.body);
        const { modified, replacements } = processBody(body);

        if (modified) {
          options = { ...options, body: JSON.stringify(body) };
          notifySubstitutions(replacements);
          console.log(
            `[Silent Send] Substituted ${replacements.length} value(s) in fetch request`
          );
        }
      } catch (e) {
        // Not JSON — pass through
      }
    }

    return originalFetch.call(this, url, options);
  };

  // ============================================================
  // XMLHttpRequest Interception (fallback)
  // ============================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (
      settings.enabled && mappings.length > 0 &&
      typeof body === 'string' && this._ssUrl &&
      (this._ssUrl.includes('/chat_conversations/') ||
        this._ssUrl.includes('/completion') ||
        this._ssUrl.includes('/messages'))
    ) {
      try {
        const parsed = JSON.parse(body);
        const { modified, replacements } = processBody(parsed);
        if (modified) {
          body = JSON.stringify(parsed);
          notifySubstitutions(replacements);
        }
      } catch (e) { /* pass through */ }
    }
    return origSend.call(this, body);
  };

  // ============================================================
  // Response Observer (reveal mode)
  // ============================================================
  function observeResponses() {
    const observer = new MutationObserver((mutations) => {
      if (!settings.revealMode || mappings.length === 0) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Claude response selectors
          const responseEls = node.querySelectorAll
            ? node.querySelectorAll('[data-is-streaming], .font-claude-message, .prose, [class*="Message"]')
            : [];

          for (const el of responseEls) revealInElement(el);

          if (node.matches?.('[data-is-streaming], .font-claude-message, .prose, [class*="Message"]')) {
            revealInElement(node);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function revealInElement(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const original = textNode.textContent;
      const revealed = reveal(original, mappings);
      if (revealed !== original) {
        textNode.textContent = revealed;
      }
    }
  }

  // ============================================================
  // Shadow DOM Traversal
  // ============================================================
  function traverseShadowRoots() {
    const visited = new WeakSet();

    function walk(root) {
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot && !visited.has(el.shadowRoot)) {
          visited.add(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    }

    // Initial + periodic scan
    walk(document);
    setInterval(() => walk(document), 3000);
  }

  // ============================================================
  // Input Highlighting
  // ============================================================
  document.addEventListener('input', (e) => {
    if (!settings.showHighlights || mappings.length === 0) return;
    const target = e.target;
    if (target.matches?.('[contenteditable], textarea, input[type="text"]')) {
      const text = target.textContent || target.value || '';
      let hasMatches = false;
      for (const m of mappings) {
        if (!m.enabled || !m.real) continue;
        if (text.toLowerCase().includes(m.real.toLowerCase())) {
          hasMatches = true;
          break;
        }
      }
      target.classList.toggle('ss-has-sensitive', hasMatches);
    }
  }, true);

  // ============================================================
  // Boot
  // ============================================================
  if (document.body) {
    observeResponses();
  } else {
    document.addEventListener('DOMContentLoaded', observeResponses);
  }
  traverseShadowRoots();

  console.log(
    `[Silent Send] Active on ${location.hostname} with ${mappings.length} mapping(s)`
  );
})();
