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
  let identity = {};
  let settings = { enabled: true, revealMode: false, showHighlights: false };

  try {
    const configEl = document.querySelector('script[data-ss-config]');
    if (configEl) {
      const config = JSON.parse(configEl.getAttribute('data-ss-config'));
      mappings = config.mappings || [];
      identity = config.identity || {};
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
      if (event.data.identity) identity = event.data.identity;
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
      const escaped = esc(m.real);
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
      const escaped = esc(m.substitute);
      const regex = new RegExp(escaped, m.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, m.real);
    }
    return result;
  }

  function esc(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ============================================================
  // Smart Pattern Engine (inline for page world)
  // ============================================================
  const COMMON_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk',
    'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com',
    'mail.com', 'zoho.com', 'fastmail.com',
    'yandex.com', 'gmx.com', 'gmx.net',
    'comcast.net', 'verizon.net', 'att.net', 'cox.net',
    'sbcglobal.net', 'charter.net', 'bellsouth.net',
  ]);

  function smartSubstitute(text, id) {
    if (!id || !id.enabled) return { text, replacements: [] };
    const replacements = [];
    let result = text;

    // Emails
    if (id.enabled.emails !== false) {
      const emailMap = new Map();
      for (const e of (id.emails || [])) {
        emailMap.set(e.real.toLowerCase(), e.substitute);
      }
      const myDomains = new Set((id.emailDomains || []).map(d => d.toLowerCase()));
      const emailRegex = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
      const matches = [];
      let m;
      while ((m = emailRegex.exec(result)) !== null) {
        matches.push({ index: m.index, value: m[0] });
      }
      for (let i = matches.length - 1; i >= 0; i--) {
        const em = matches[i];
        const lower = em.value.toLowerCase();
        const domain = lower.split('@')[1];
        let replacement = null;
        if (emailMap.has(lower)) {
          replacement = emailMap.get(lower);
        } else if (COMMON_EMAIL_DOMAINS.has(domain) || myDomains.has(domain)) {
          replacement = id.catchAllEmail || 'user@example.com';
        }
        if (replacement) {
          replacements.push({ original: em.value, replaced: replacement, category: 'email', pattern: 'smart' });
          result = result.slice(0, em.index) + replacement + result.slice(em.index + em.value.length);
        }
      }
    }

    // Phones
    if (id.enabled.phones !== false) {
      for (const p of (id.phones || [])) {
        if (!p.real || !p.substitute) continue;
        const digits = p.real.replace(/\D/g, '');
        if (digits.length < 7) continue;
        const d = digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
        if (d.length !== 10 && d.length !== 7) continue;
        let pattern;
        if (d.length === 10) {
          const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6);
          pattern = '(?:\\+?1[\\s.-]?)?(?:' + esc(a) + '|\\(' + esc(a) + '\\))[\\s.\\-]?' + esc(b) + '[\\s.\\-]?' + esc(c);
        } else {
          pattern = esc(d.slice(0, 3)) + '[\\s.\\-]?' + esc(d.slice(3));
        }
        const phoneRegex = new RegExp(pattern, 'g');
        result = result.replace(phoneRegex, (matched) => {
          replacements.push({ original: matched, replaced: p.substitute, category: 'phone', pattern: 'smart' });
          return p.substitute;
        });
      }
    }

    // Names (full names first, then individual)
    if (id.enabled.names !== false) {
      const names = id.names || [];
      const firsts = names.filter(n => n.type === 'first');
      const lasts = names.filter(n => n.type === 'last');

      for (const first of firsts) {
        for (const last of lasts) {
          // "First Last"
          result = result.replace(new RegExp(esc(first.real) + '\\s+' + esc(last.real), 'gi'), (matched) => {
            const sub = `${first.substitute} ${last.substitute}`;
            replacements.push({ original: matched, replaced: sub, category: 'name', pattern: 'smart' });
            return sub;
          });
          // "Last, First"
          result = result.replace(new RegExp(esc(last.real) + ',\\s*' + esc(first.real), 'gi'), (matched) => {
            const sub = `${last.substitute}, ${first.substitute}`;
            replacements.push({ original: matched, replaced: sub, category: 'name', pattern: 'smart' });
            return sub;
          });
        }
      }

      for (const name of names) {
        if (!name.real || !name.substitute) continue;
        result = result.replace(new RegExp('\\b' + esc(name.real) + "(?:'s)?\\b", 'gi'), (matched) => {
          const isPossessive = matched.endsWith("'s");
          const sub = isPossessive ? name.substitute + "'s" : name.substitute;
          replacements.push({ original: matched, replaced: sub, category: 'name', pattern: 'smart' });
          return sub;
        });
      }
    }

    // Usernames + hostnames + paths
    if (id.enabled.usernames !== false) {
      const hostMap = new Map();
      for (const h of (id.hostnames || [])) {
        if (h.real && h.substitute) hostMap.set(h.real.toLowerCase(), h);
      }

      for (const u of (id.usernames || [])) {
        if (!u.real || !u.substitute) continue;

        // user@hostname (substitute both username and hostname if configured)
        result = result.replace(new RegExp(esc(u.real) + '@[a-zA-Z0-9._\\-]+', 'g'), (matched) => {
          const host = matched.slice(u.real.length + 1);
          const hostEntry = hostMap.get(host.toLowerCase());
          const subHost = hostEntry ? hostEntry.substitute : host;
          const sub = u.substitute + '@' + subHost;
          replacements.push({ original: matched, replaced: sub, category: 'username', pattern: 'smart' });
          return sub;
        });

        // ~username
        result = result.replace(new RegExp('~' + esc(u.real) + '\\b', 'g'), (matched) => {
          const sub = '~' + u.substitute;
          replacements.push({ original: matched, replaced: sub, category: 'username', pattern: 'smart' });
          return sub;
        });

        // /home/username, /Users/username
        result = result.replace(new RegExp('(/(?:home|Users)/)' + esc(u.real) + '(?=/|\\s|$|"|\')', 'g'), (matched, prefix) => {
          const sub = prefix + u.substitute;
          replacements.push({ original: matched, replaced: sub, category: 'path', pattern: 'smart' });
          return sub;
        });

        // C:\Users\username
        result = result.replace(new RegExp('([A-Z]:\\\\Users\\\\)' + esc(u.real) + '(?=\\\\|\\s|$|"|\')', 'gi'), (matched, prefix) => {
          const sub = prefix + u.substitute;
          replacements.push({ original: matched, replaced: sub, category: 'path', pattern: 'smart' });
          return sub;
        });

        // plain username (3+ chars to avoid false positives)
        if (u.real.length >= 3) {
          result = result.replace(new RegExp('\\b' + esc(u.real) + '\\b', 'g'), (matched) => {
            replacements.push({ original: matched, replaced: u.substitute, category: 'username', pattern: 'smart' });
            return u.substitute;
          });
        }
      }

      // Standalone hostname substitution
      for (const [, h] of hostMap) {
        if (h.real.length >= 3) {
          result = result.replace(new RegExp('\\b' + esc(h.real) + '\\b', 'gi'), (matched) => {
            replacements.push({ original: matched, replaced: h.substitute, category: 'hostname', pattern: 'smart' });
            return h.substitute;
          });
        }
      }
    }

    return { text: result, replacements };
  }

  // ============================================================
  // Combined substitution: smart patterns first, then explicit
  // ============================================================
  function substituteAll(text) {
    const allReplacements = [];

    // Smart patterns (broad catches)
    const smart = smartSubstitute(text, identity);
    allReplacements.push(...smart.replacements);

    // Explicit mappings (specific overrides)
    const explicit = substitute(smart.text, mappings);
    allReplacements.push(...explicit.replacements);

    return {
      text: explicit.text,
      replacements: allReplacements,
      modified: allReplacements.length > 0,
    };
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

    function processText(text) {
      const r = substituteAll(text);
      if (r.modified) {
        allReplacements.push(...r.replacements);
        modified = true;
      }
      return r;
    }

    // Shape 1: { prompt: "..." }
    if (typeof body.prompt === 'string') {
      const r = processText(body.prompt);
      if (r.modified) body.prompt = r.text;
    }

    // Shape 2: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(body.content)) {
      for (let i = 0; i < body.content.length; i++) {
        const item = body.content[i];
        if (item.type === 'text' && typeof item.text === 'string') {
          const r = processText(item.text);
          if (r.modified) body.content[i] = { ...item, text: r.text };
        }
      }
    }

    // Shape 3: { messages: [{ role: "user", content: "..." }] }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role !== 'user' && msg.role !== 'human') continue;

        if (typeof msg.content === 'string') {
          const r = processText(msg.content);
          if (r.modified) msg.content = r.text;
        }

        if (Array.isArray(msg.content)) {
          for (let j = 0; j < msg.content.length; j++) {
            if (msg.content[j].type === 'text') {
              const r = processText(msg.content[j].text);
              if (r.modified) msg.content[j] = { ...msg.content[j], text: r.text };
            }
          }
        }
      }
    }

    return { modified, replacements: allReplacements };
  }

  // ============================================================
  // Check if we have anything to substitute
  // ============================================================
  function hasSubstitutions() {
    return mappings.length > 0 ||
      (identity.emails || []).length > 0 ||
      (identity.names || []).length > 0 ||
      (identity.usernames || []).length > 0 ||
      (identity.phones || []).length > 0;
  }

  // ============================================================
  // Fetch Interception
  // ============================================================
  const originalFetch = window.fetch;

  window.fetch = async function (url, options) {
    if (!settings.enabled || !hasSubstitutions()) {
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
      settings.enabled && hasSubstitutions() &&
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
      if (!settings.revealMode || !hasSubstitutions()) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

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

    walk(document);
    setInterval(() => walk(document), 3000);
  }

  // ============================================================
  // Input Highlighting
  // ============================================================
  document.addEventListener('input', (e) => {
    if (!settings.showHighlights || !hasSubstitutions()) return;
    const target = e.target;
    if (target.matches?.('[contenteditable], textarea, input[type="text"]')) {
      const text = target.textContent || target.value || '';
      const r = substituteAll(text);
      target.classList.toggle('ss-has-sensitive', r.modified);
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

  const smartCount = (identity.emails || []).length +
    (identity.names || []).length +
    (identity.usernames || []).length +
    (identity.phones || []).length;

  console.log(
    `[Silent Send] Active on ${location.hostname} — ${mappings.length} explicit mapping(s), ${smartCount} smart pattern(s)`
  );
})();
