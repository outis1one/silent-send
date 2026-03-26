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
    if (!id) return { text, replacements: [] };
    // Default enabled to all-true if not set
    if (!id.enabled) id.enabled = { emails: true, names: true, usernames: true, phones: true, paths: true };
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
  // Combined substitution: smart patterns + explicit + secret scan
  // ============================================================
  function substituteAll(text) {
    const allReplacements = [];

    // 1. Smart patterns (broad catches)
    const smart = smartSubstitute(text, identity);
    allReplacements.push(...smart.replacements);

    // 2. Explicit mappings (specific overrides)
    const explicit = substitute(smart.text, mappings);
    allReplacements.push(...explicit.replacements);

    // 3. Secret scanner (API keys, tokens, SSNs, credit cards, etc.)
    if (settings.secretScanning !== false) {
      const secrets = scanAndRedactSecrets(explicit.text);
      allReplacements.push(...secrets.redactions);
      return {
        text: secrets.text,
        replacements: allReplacements,
        modified: allReplacements.length > 0,
      };
    }

    return {
      text: explicit.text,
      replacements: allReplacements,
      modified: allReplacements.length > 0,
    };
  }

  // ============================================================
  // Secret Scanner (inline for page world)
  // Detects API keys, tokens, passwords, SSNs, credit cards, etc.
  // ============================================================
  const SECRET_PATTERNS = [
    // OpenAI
    { name: 'OpenAI Key', re: /\bsk-[A-Za-z0-9]{20,}\b/g, to: '[REDACTED-OPENAI-KEY]' },
    { name: 'OpenAI Project Key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, to: '[REDACTED-OPENAI-KEY]' },
    // Anthropic
    { name: 'Anthropic Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, to: '[REDACTED-ANTHROPIC-KEY]' },
    // Google
    { name: 'Google API Key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g, to: '[REDACTED-GOOGLE-KEY]' },
    // AWS
    { name: 'AWS Access Key', re: /\bAKIA[A-Z0-9]{16}\b/g, to: '[REDACTED-AWS-KEY]' },
    // GitHub
    { name: 'GitHub Token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, to: '[REDACTED-GITHUB-TOKEN]' },
    // GitLab
    { name: 'GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, to: '[REDACTED-GITLAB-TOKEN]' },
    // Slack
    { name: 'Slack Token', re: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g, to: '[REDACTED-SLACK-TOKEN]' },
    // Stripe
    { name: 'Stripe Key', re: /\b[sr]k_(?:test|live)_[A-Za-z0-9]{20,}\b/g, to: '[REDACTED-STRIPE-KEY]' },
    // SendGrid
    { name: 'SendGrid Key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, to: '[REDACTED-SENDGRID-KEY]' },
    // Bearer tokens
    { name: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9_\-./+=]{20,}\b/g, to: 'Bearer [REDACTED]' },
    // Private keys
    { name: 'Private Key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, to: '[REDACTED-PRIVATE-KEY]' },
    // Generic key=value assignments
    { name: 'API Key Assignment', re: /\b(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
      fn: (m) => m.replace(/[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}['"]?/, '=[REDACTED]') },
    { name: 'Password/Secret Assignment', re: /\b(?:password|passwd|pwd|secret|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
      fn: (m) => m.replace(/[:=]\s*['"]?[^\s'"]{8,}['"]?/, '=[REDACTED]') },
    // Connection strings with credentials
    { name: 'Connection String', re: /\b(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"']+/gi,
      fn: (m) => m.replace(/:\/\/([^:]+):([^@]+)@/, '://REDACTED:REDACTED@') },
    // SSN
    { name: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g, to: '[REDACTED-SSN]' },
    // Credit cards (Visa, MC, Amex, Discover)
    { name: 'Credit Card', re: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, to: '[REDACTED-CARD]' },
  ];

  function scanAndRedactSecrets(text) {
    const redactions = [];
    let result = text;

    for (const pat of SECRET_PATTERNS) {
      pat.re.lastIndex = 0;
      const matches = [];
      let m;

      while ((m = pat.re.exec(result)) !== null) {
        matches.push({ index: m.index, value: m[0] });
      }

      if (matches.length === 0) continue;

      // Replace from end to preserve indices
      for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        const replacement = pat.fn ? pat.fn(match.value) : pat.to;
        redactions.push({
          original: match.value.slice(0, 8) + '...',  // Don't log the full secret
          replaced: replacement,
          category: 'secret',
          pattern: pat.name,
        });
        result =
          result.slice(0, match.index) +
          replacement +
          result.slice(match.index + match.value.length);
      }
    }

    redactions.reverse();
    return { text: result, redactions };
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
  // Deep JSON scanner — finds and substitutes ALL strings in
  // any JSON structure. Service-agnostic. Survives API changes.
  // ============================================================
  const SKIP_KEYS = new Set([
    // Keys that should never be modified (auth, metadata, IDs)
    'model', 'id', 'parent_message_id', 'conversation_id',
    'organization_id', 'uuid', 'token', 'api_key', 'key',
    'authorization', 'cookie', 'csrf', 'nonce', 'hash',
    'Content-Type', 'content-type', 'Accept', 'accept',
    'User-Agent', 'user-agent', 'x-request-id',
  ]);

  // Min length for a string to be worth scanning
  const MIN_STRING_LENGTH = 2;

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

    // Recursively walk any JSON structure and substitute all strings
    function deepWalk(obj, parentKey) {
      if (typeof obj === 'string') {
        if (obj.length >= MIN_STRING_LENGTH) {
          return processText(obj);
        }
        return { text: obj, modified: false };
      }

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          if (typeof obj[i] === 'string' && obj[i].length >= MIN_STRING_LENGTH) {
            const r = processText(obj[i]);
            if (r.modified) obj[i] = r.text;
          } else if (typeof obj[i] === 'object' && obj[i] !== null) {
            deepWalk(obj[i], null);
          }
        }
        return;
      }

      if (typeof obj === 'object' && obj !== null) {
        for (const key of Object.keys(obj)) {
          // Skip metadata/auth keys
          if (SKIP_KEYS.has(key)) continue;

          const val = obj[key];
          if (typeof val === 'string' && val.length >= MIN_STRING_LENGTH) {
            const r = processText(val);
            if (r.modified) obj[key] = r.text;
          } else if (typeof val === 'object' && val !== null) {
            deepWalk(val, key);
          }
        }
      }
    }

    deepWalk(body, null);
    return { modified, replacements: allReplacements };
  }

  // ============================================================
  // Check if we have anything to substitute
  // ============================================================
  // Check if the user has configured anything at all.
  // If not, the extension is effectively disabled — no interception.
  function isConfigured() {
    return mappings.length > 0 ||
      (identity.emails || []).length > 0 ||
      (identity.names || []).length > 0 ||
      (identity.usernames || []).length > 0 ||
      (identity.hostnames || []).length > 0 ||
      (identity.phones || []).length > 0 ||
      !!identity.catchAllEmail;
  }

  function hasSubstitutions() {
    return isConfigured();
  }

  // ============================================================
  // Fetch Interception — scans ALL POST requests with a body.
  // Service-agnostic: doesn't depend on URL patterns.
  // ============================================================
  const originalFetch = window.fetch;

  // URLs to never touch (static assets, analytics, etc.)
  const SKIP_URL_PATTERNS = [
    /\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/i,
    /\/analytics\//i,
    /\/telemetry\//i,
    /\/log\//i,
    /google-analytics/i,
    /sentry/i,
  ];

  function shouldSkipUrl(url) {
    return SKIP_URL_PATTERNS.some(p => p.test(url));
  }

  window.fetch = async function (url, options) {
    if (!settings.enabled || !hasSubstitutions()) {
      return originalFetch.call(this, url, options);
    }

    const urlStr = typeof url === 'string' ? url : url?.url || '';
    const method = (options?.method || 'GET').toUpperCase();

    // Only intercept POST/PUT/PATCH with a string body
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
      options?.body && typeof options.body === 'string' &&
      !shouldSkipUrl(urlStr)
    ) {
      try {
        // Try JSON
        const body = JSON.parse(options.body);
        const { modified, replacements } = processBody(body);

        if (modified) {
          options = { ...options, body: JSON.stringify(body) };
          notifySubstitutions(replacements);
          console.log(
            `[Silent Send] Substituted ${replacements.length} value(s) in ${urlStr}`
          );
        }
      } catch (e) {
        // Not JSON — try raw string substitution (form data, etc.)
        if (options.body.length > MIN_STRING_LENGTH) {
          const result = substituteAll(options.body);
          if (result.modified) {
            options = { ...options, body: result.text };
            notifySubstitutions(result.replacements);
            console.log(
              `[Silent Send] Substituted ${result.replacements.length} value(s) in form body`
            );
          }
        }
      }
    }

    return originalFetch.call(this, url, options);
  };

  // ============================================================
  // XMLHttpRequest Interception — same aggressive approach
  // ============================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = url;
    this._ssMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const method = (this._ssMethod || 'GET').toUpperCase();
    if (
      settings.enabled && hasSubstitutions() &&
      (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
      typeof body === 'string' && body.length > MIN_STRING_LENGTH &&
      !shouldSkipUrl(this._ssUrl || '')
    ) {
      try {
        const parsed = JSON.parse(body);
        const { modified, replacements } = processBody(parsed);
        if (modified) {
          body = JSON.stringify(parsed);
          notifySubstitutions(replacements);
        }
      } catch (e) {
        // Not JSON — raw string
        const result = substituteAll(body);
        if (result.modified) {
          body = result.text;
          notifySubstitutions(result.replacements);
        }
      }
    }
    return origSend.call(this, body);
  };

  // ============================================================
  // Response Reveal — swaps fake data back to real in the page
  // ============================================================

  // Build reverse mapping pairs from identity + explicit mappings
  function buildRevealPairs() {
    const pairs = [];

    // Explicit mappings (substitute → real)
    for (const m of mappings) {
      if (!m.enabled || !m.substitute || !m.real) continue;
      pairs.push({ from: m.substitute, to: m.real, caseSensitive: m.caseSensitive });
    }

    // Smart identity pairs (substitute → real)
    if (identity) {
      for (const e of (identity.emails || [])) {
        if (e.substitute && e.real) pairs.push({ from: e.substitute, to: e.real });
      }
      if (identity.catchAllEmail) {
        // Can't reverse a catch-all to a specific email, but we mark it
        // so the user sees it was a substitution
      }
      for (const n of (identity.names || [])) {
        if (n.substitute && n.real) pairs.push({ from: n.substitute, to: n.real });
      }
      for (const u of (identity.usernames || [])) {
        if (u.substitute && u.real) pairs.push({ from: u.substitute, to: u.real });
      }
      for (const h of (identity.hostnames || [])) {
        if (h.substitute && h.real) pairs.push({ from: h.substitute, to: h.real });
      }
      for (const p of (identity.phones || [])) {
        if (p.substitute && p.real) pairs.push({ from: p.substitute, to: p.real });
      }
    }

    // Sort longer matches first
    pairs.sort((a, b) => b.from.length - a.from.length);
    return pairs;
  }

  // Cache reveal pairs — rebuild when config changes
  let _revealPairsCache = null;
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'ss:config-updated') _revealPairsCache = null;
  });

  function revealText(text) {
    if (!_revealPairsCache) _revealPairsCache = buildRevealPairs();
    const pairs = _revealPairsCache;
    let result = text;
    for (const p of pairs) {
      const escaped = esc(p.from);
      const regex = new RegExp(escaped, p.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, p.to);
    }
    return result;
  }

  // Store originals so we can un-reveal when toggled off
  const originalTexts = new WeakMap();

  function revealInElement(el) {
    if (SKIP_REVEAL_TAGS.has(el.tagName)) return;
    // Skip our own badge
    if (el.classList?.contains('ss-reveal-badge')) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && SKIP_REVEAL_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent?.classList?.contains('ss-reveal-badge')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      if (!text || text.length < MIN_STRING_LENGTH) continue;

      if (!originalTexts.has(textNode)) {
        originalTexts.set(textNode, text);
      }

      const revealed = revealText(text);
      if (revealed !== text) {
        textNode.textContent = revealed;
      }
    }
  }

  function unrevealInElement(el) {
    if (SKIP_REVEAL_TAGS.has(el.tagName)) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const original = originalTexts.get(textNode);
      if (original && textNode.textContent !== original) {
        textNode.textContent = original;
      }
    }
  }

  // Elements to skip when revealing (inputs, scripts, styles, extension UI)
  const SKIP_REVEAL_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT',
  ]);

  // Reveal ALL text on the page (not just specific selectors)
  function revealAllResponses() {
    revealInElement(document.body);
  }

  // Un-reveal ALL text on the page
  function unrevealAllResponses() {
    unrevealInElement(document.body);
  }

  // Watch for ANY new content on the page
  function observeResponses() {
    const observer = new MutationObserver((mutations) => {
      if (!settings.revealMode || !hasSubstitutions()) return;

      for (const mutation of mutations) {
        // Handle new nodes — reveal all text in them
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (!SKIP_REVEAL_TAGS.has(node.tagName)) {
              revealInElement(node);
            }
          } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text && text.length >= MIN_STRING_LENGTH) {
              if (!originalTexts.has(node)) {
                originalTexts.set(node, text);
              }
              const revealed = revealText(text);
              if (revealed !== text) {
                node.textContent = revealed;
              }
            }
          }
        }

        // Handle text changes in existing nodes (streaming responses)
        if (mutation.type === 'characterData' && settings.revealMode) {
          const text = mutation.target.textContent;
          if (text && text.length >= MIN_STRING_LENGTH) {
            const parent = mutation.target.parentElement;
            if (parent && !SKIP_REVEAL_TAGS.has(parent.tagName)) {
              if (!originalTexts.has(mutation.target)) {
                originalTexts.set(mutation.target, text);
              }
              const revealed = revealText(text);
              if (revealed !== text) {
                mutation.target.textContent = revealed;
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // React to reveal mode toggle
  let prevRevealMode = settings.revealMode;
  let revealInterval = null;

  function checkRevealToggle() {
    if (settings.revealMode && !prevRevealMode) {
      // Just turned ON — reveal everything existing
      console.log('[Silent Send] Reveal mode ON');
      revealAllResponses();
      // Keep re-revealing periodically to catch new/streamed content
      revealInterval = setInterval(() => {
        if (settings.revealMode) revealAllResponses();
      }, 2000);
    } else if (!settings.revealMode && prevRevealMode) {
      // Just turned OFF — restore originals
      console.log('[Silent Send] Reveal mode OFF');
      if (revealInterval) { clearInterval(revealInterval); revealInterval = null; }
      unrevealAllResponses();
    }
    prevRevealMode = settings.revealMode;
  }

  // Hook into config updates to detect reveal toggle
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'ss:config-updated') {
      // Settings were updated — check if reveal mode changed
      setTimeout(checkRevealToggle, 100);
    }
  });

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
  // Reveal Mode Badge
  // ============================================================
  let revealBadge = null;

  function ensureRevealBadge() {
    if (revealBadge) return revealBadge;
    revealBadge = document.createElement('div');
    revealBadge.className = 'ss-reveal-badge';
    revealBadge.textContent = 'Reveal Mode — showing real data';
    document.body.appendChild(revealBadge);
    return revealBadge;
  }

  function updateRevealBadge() {
    const badge = ensureRevealBadge();
    badge.classList.toggle('visible', !!settings.revealMode);
  }

  // ============================================================
  // Boot
  // ============================================================
  function boot() {
    observeResponses();
    traverseShadowRoots();
    updateRevealBadge();

    // If reveal mode was already on at page load, reveal everything
    if (settings.revealMode && hasSubstitutions()) {
      // Wait for page content to render
      setTimeout(revealAllResponses, 1000);
      setTimeout(revealAllResponses, 3000);
    }

    const smartCount = (identity.emails || []).length +
      (identity.names || []).length +
      (identity.usernames || []).length +
      (identity.phones || []).length;

    console.log(
      `[Silent Send] Active on ${location.hostname} — ${mappings.length} explicit mapping(s), ${smartCount} smart pattern(s)`
    );
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }

  // Also update badge when settings change
  const origCheckReveal = checkRevealToggle;
  checkRevealToggle = function () {
    origCheckReveal();
    updateRevealBadge();
  };
})();
