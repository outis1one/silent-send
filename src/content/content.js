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

  // --- Safe innerHTML replacement (AMO-compliant, page world) ---
  function safeHTML(el, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    el.replaceChildren(...template.content.childNodes);
  }

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
  // + auto-detect warning for unconfigured PPI
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
    let finalText = explicit.text;
    if (settings.secretScanning !== false) {
      const secrets = scanAndRedactSecrets(finalText);
      allReplacements.push(...secrets.redactions);
      finalText = secrets.text;
    }

    // 4. Auto-detect: scan the FINAL text for unconfigured PPI
    //    Auto-redact if enabled, otherwise just warn
    if (settings.autoDetect !== false) {
      const warnings = autoDetectPPI(finalText, identity);
      if (warnings.length > 0) {
        // Auto-redact detected PPI in the outbound text
        if (settings.autoRedactDetected !== false) {
          for (let i = warnings.length - 1; i >= 0; i--) {
            const w = warnings[i];
            const fake = generateFake(w.name, w.value);
            const escaped = esc(w.value);
            const regex = new RegExp(escaped, 'g');
            finalText = finalText.replace(regex, fake);
            allReplacements.push({
              original: w.value,
              replaced: fake,
              category: 'auto-detect',
              pattern: w.name,
            });
          }
        }
        // Still show the warning so user knows what was caught
        showAutoDetectWarning(warnings);
      }
    }

    return {
      text: finalText,
      replacements: allReplacements,
      modified: allReplacements.length > 0,
    };
  }

  // ============================================================
  // Auto-Detect PPI Scanner (inline for page world)
  // ============================================================
  const PPI_PATTERNS = [
    // Network
    { name: 'Private IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
      hint: 'Private IP address', cat: 'network' },
    { name: 'Public IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
      hint: 'IP address — could identify your network', cat: 'network',
      skip: /^(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+|8\.8\.[84]\.[84]|1\.1\.1\.1)$/ },
    { name: 'MAC Address', re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
      hint: 'MAC address — identifies hardware', cat: 'network' },
    // Location
    { name: 'Street Address', re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place)\.?\b/gi,
      hint: 'Street address', cat: 'address' },
    { name: 'GPS Coordinates', re: /\b-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/g,
      hint: 'GPS coordinates — pinpoints a location', cat: 'address' },
    // Personal
    { name: 'Date (possible DOB)', re: /\b(?:(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}|(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01]))\b/g,
      hint: 'Date — could be a birthday', cat: 'personal', contextRequired: true },
    { name: 'EIN / Tax ID', re: /\b\d{2}-\d{7}\b/g,
      hint: 'Could be a tax ID', cat: 'document' },
    // Paths not caught by smart patterns
    { name: 'Home Path', re: /(?:\/home\/|\/Users\/|C:\\Users\\)[a-zA-Z0-9._-]+/g,
      hint: 'Home directory — reveals username', cat: 'path' },
    // Shell prompts
    { name: 'Shell Prompt', re: /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[:\$#%>]\s/g,
      hint: 'Shell prompt — reveals user@host', cat: 'prompt' },
    // Git remotes
    { name: 'Git Remote', re: /(?:git@|https:\/\/)(?:github|gitlab|bitbucket)\.[a-z]+[:/][^\s]+/gi,
      hint: 'Git remote — may reveal username/org', cat: 'url' },
    // Env vars
    { name: 'Env Variable', re: /\b(?:HOME|USER|USERNAME|LOGNAME|HOSTNAME|COMPUTERNAME|EMAIL)=[^\s]+/gi,
      hint: 'Env variable with personal data', cat: 'env' },
  ];

  const CONTEXT_WORDS_RE = /\b(?:born|birthday|dob|birth|passport|license|driver|ssn|social\s*security|address|zip|postal|date\s+of\s+birth)\b/i;

  // Common English words that are capitalized but aren't proper nouns.
  // Used by the proper noun heuristic to reduce false positives.
  // Includes common verbs, nouns, adjectives that appear in titles,
  // headings, UI buttons, and instructions.
  const COMMON_CAPITALIZED = new Set([
    // Prepositions, conjunctions, articles, pronouns
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
    'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through',
    'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
    'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
    'once', 'here', 'there', 'all', 'each', 'every', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
    'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will',
    'just', 'should', 'now', 'also', 'into', 'could', 'would', 'may',
    'might', 'shall', 'must', 'need', 'have', 'has', 'had', 'do', 'does',
    'did', 'be', 'is', 'am', 'are', 'was', 'were', 'been', 'being',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
    'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'this', 'that', 'these', 'those', 'what', 'who', 'how', 'why',
    'which', 'where', 'when', 'while', 'since', 'because', 'although',
    'however', 'therefore', 'moreover', 'furthermore', 'nevertheless',
    // Common verbs (appear in titles, headings, buttons, instructions)
    'get', 'got', 'make', 'made', 'go', 'went', 'gone', 'take', 'took',
    'come', 'came', 'see', 'saw', 'know', 'knew', 'think', 'thought',
    'say', 'said', 'tell', 'told', 'give', 'gave', 'find', 'found',
    'want', 'let', 'put', 'set', 'run', 'keep', 'try', 'start', 'turn',
    'show', 'hear', 'play', 'move', 'live', 'believe', 'bring', 'happen',
    'write', 'provide', 'sit', 'stand', 'lose', 'pay', 'meet', 'include',
    'continue', 'learn', 'change', 'lead', 'understand', 'watch', 'follow',
    'stop', 'create', 'speak', 'read', 'allow', 'add', 'spend', 'grow',
    'open', 'walk', 'win', 'offer', 'remember', 'love', 'consider', 'appear',
    'buy', 'wait', 'serve', 'die', 'send', 'expect', 'build', 'stay',
    'fall', 'cut', 'reach', 'kill', 'remain', 'suggest', 'raise', 'pass',
    'sell', 'require', 'report', 'decide', 'pull', 'develop', 'note',
    'generate', 'design', 'manage', 'process', 'handle', 'check', 'verify',
    'submit', 'apply', 'accept', 'reject', 'approve', 'deny', 'confirm',
    'cancel', 'delete', 'remove', 'edit', 'modify', 'view', 'display',
    'search', 'filter', 'sort', 'select', 'choose', 'pick', 'enter',
    'input', 'output', 'upload', 'download', 'install', 'uninstall',
    'enable', 'disable', 'activate', 'deactivate', 'toggle', 'switch',
    'connect', 'disconnect', 'sync', 'refresh', 'reload', 'reset',
    'save', 'load', 'store', 'restore', 'backup', 'export', 'import',
    'copy', 'paste', 'drag', 'drop', 'click', 'press', 'hold', 'release',
    'scroll', 'zoom', 'resize', 'expand', 'collapse', 'hide', 'reveal',
    'lock', 'unlock', 'encrypt', 'decrypt', 'sign', 'register', 'login',
    'logout', 'subscribe', 'unsubscribe', 'share', 'publish', 'deploy',
    'launch', 'test', 'debug', 'fix', 'patch', 'merge', 'split', 'join',
    'link', 'attach', 'detach', 'insert', 'append', 'prepend', 'wrap',
    'format', 'parse', 'convert', 'transform', 'translate', 'compile',
    'execute', 'render', 'animate', 'validate', 'sanitize', 'escape',
    // Common nouns (appear in titles, headings, labels)
    'account', 'action', 'address', 'alert', 'analysis', 'answer',
    'application', 'area', 'article', 'asset', 'background', 'badge',
    'banner', 'board', 'body', 'border', 'bottom', 'box', 'brand',
    'browser', 'buffer', 'button', 'cache', 'calendar', 'card', 'case',
    'category', 'center', 'channel', 'chart', 'chat', 'child', 'choice',
    'class', 'client', 'cloud', 'cluster', 'code', 'collection', 'color',
    'column', 'command', 'comment', 'community', 'company', 'component',
    'config', 'configuration', 'connection', 'console', 'contact',
    'container', 'content', 'context', 'control', 'corner', 'count',
    'country', 'cover', 'custom', 'dashboard', 'data', 'database',
    'date', 'day', 'default', 'description', 'design', 'desktop',
    'detail', 'device', 'dialog', 'directory', 'document', 'domain',
    'draft', 'driver', 'edge', 'editor', 'element', 'email', 'end',
    'engine', 'entry', 'environment', 'error', 'event', 'example',
    'exception', 'extension', 'feature', 'feedback', 'field', 'file',
    'filter', 'folder', 'font', 'footer', 'form', 'format', 'frame',
    'function', 'gallery', 'general', 'global', 'grid', 'group',
    'guide', 'handler', 'header', 'health', 'help', 'helper', 'history',
    'home', 'host', 'icon', 'image', 'index', 'info', 'input', 'instance',
    'interface', 'issue', 'item', 'job', 'key', 'label', 'language',
    'layout', 'level', 'library', 'light', 'limit', 'line', 'link',
    'list', 'local', 'location', 'log', 'logo', 'main', 'manager',
    'manual', 'map', 'margin', 'master', 'match', 'media', 'member',
    'memory', 'menu', 'message', 'method', 'middle', 'mobile', 'modal',
    'mode', 'model', 'module', 'monitor', 'name', 'navigation', 'network',
    'node', 'note', 'notification', 'number', 'object', 'option',
    'order', 'origin', 'output', 'overlay', 'overview', 'owner', 'package',
    'padding', 'page', 'panel', 'parent', 'parser', 'password', 'path',
    'pattern', 'permission', 'photo', 'pipeline', 'placeholder', 'plan',
    'platform', 'player', 'plugin', 'point', 'policy', 'pool', 'popup',
    'port', 'position', 'post', 'power', 'preview', 'primary', 'print',
    'priority', 'process', 'product', 'profile', 'program', 'progress',
    'project', 'prompt', 'property', 'protocol', 'provider', 'proxy',
    'public', 'query', 'queue', 'quick', 'radio', 'range', 'rate',
    'reader', 'record', 'region', 'release', 'remote', 'render',
    'report', 'request', 'resource', 'response', 'result', 'review',
    'role', 'root', 'route', 'row', 'rule', 'runtime', 'sample',
    'scanner', 'schema', 'scope', 'screen', 'script', 'search',
    'section', 'security', 'select', 'sender', 'server', 'service',
    'session', 'setting', 'settings', 'setup', 'share', 'shell',
    'shortcut', 'sidebar', 'signal', 'simple', 'single', 'site', 'size',
    'slider', 'slot', 'snapshot', 'socket', 'solution', 'source', 'space',
    'stage', 'standard', 'start', 'state', 'status', 'step', 'stop',
    'storage', 'store', 'stream', 'string', 'style', 'subject',
    'success', 'summary', 'support', 'switch', 'symbol', 'syntax',
    'system', 'table', 'target', 'task', 'team', 'template', 'terminal',
    'test', 'text', 'theme', 'thread', 'time', 'timer', 'title', 'token',
    'tool', 'toolbar', 'tooltip', 'top', 'total', 'track', 'traffic',
    'tree', 'trigger', 'type', 'unit', 'update', 'upload', 'user',
    'util', 'utility', 'value', 'variable', 'version', 'video', 'view',
    'virtual', 'warning', 'watch', 'web', 'widget', 'width', 'window',
    'wizard', 'word', 'worker', 'workspace', 'wrapper', 'zone',
    // Common adjectives
    'active', 'advanced', 'available', 'basic', 'best', 'better', 'blank',
    'bold', 'clean', 'clear', 'close', 'closed', 'complete', 'complex',
    'connected', 'correct', 'critical', 'current', 'dark', 'deep',
    'detailed', 'different', 'direct', 'double', 'dynamic', 'early',
    'easy', 'empty', 'entire', 'equal', 'essential', 'exact', 'extra',
    'fast', 'final', 'fine', 'fixed', 'flat', 'free', 'fresh', 'front',
    'full', 'generic', 'given', 'good', 'great', 'green', 'hard',
    'hidden', 'high', 'hot', 'huge', 'human', 'initial', 'inner',
    'internal', 'invalid', 'large', 'late', 'latest', 'left', 'light',
    'live', 'long', 'low', 'major', 'maximum', 'middle', 'minimum',
    'minor', 'mixed', 'modern', 'multiple', 'native', 'natural',
    'nested', 'neutral', 'new', 'normal', 'null', 'old', 'online',
    'open', 'optional', 'outer', 'overall', 'parallel', 'partial',
    'pending', 'plain', 'popular', 'possible', 'previous', 'primary',
    'private', 'proper', 'protected', 'quick', 'random', 'raw', 'ready',
    'real', 'recent', 'red', 'related', 'relative', 'remote', 'required',
    'responsive', 'rich', 'right', 'round', 'safe', 'secure', 'selected',
    'sensitive', 'separate', 'serial', 'shared', 'short', 'silent',
    'similar', 'simple', 'single', 'small', 'smart', 'smooth', 'soft',
    'solid', 'special', 'specific', 'stable', 'standard', 'static',
    'strict', 'strong', 'supported', 'sweet', 'thin', 'tight', 'tiny',
    'total', 'true', 'unique', 'universal', 'unknown', 'upper', 'valid',
    'various', 'virtual', 'visible', 'visual', 'warm', 'weak', 'white',
    'whole', 'wide', 'wild',
    // Programming/tech terms
    'string', 'number', 'boolean', 'object', 'array', 'function', 'class',
    'type', 'error', 'null', 'undefined', 'true', 'false', 'return',
    'import', 'export', 'default', 'const', 'let', 'var', 'async', 'await',
    'try', 'catch', 'throw', 'finally', 'switch', 'case', 'break',
    'example', 'warning', 'important', 'todo', 'fixme', 'hack',
    // Common sentence starters
    'please', 'thanks', 'hello', 'hi', 'hey', 'dear', 'sincerely',
    'regards', 'best', 'cheers', 'sorry', 'yes', 'ok', 'okay',
    // Days and months
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  ]);

  /**
   * Detect proper nouns (potential names, company names, project names)
   * that aren't configured in identity. Uses capitalization heuristics:
   * - ONLY multi-word capitalized sequences (e.g. "Acme Corp", "Project Atlas")
   * - Single capitalized words are too noisy — every sentence starts with one
   * - Filters out common English words and programming terms
   */
  function detectProperNouns(text, configured) {
    const findings = [];
    // Only match TWO OR MORE consecutive capitalized words
    // Single capitalized words cause too many false positives
    const re = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;
    let m;

    while ((m = re.exec(text)) !== null) {
      const fullMatch = m[1];
      if (!fullMatch) continue;

      // Split into individual words and filter common ones
      const words = fullMatch.split(/\s+/);
      const properWords = words.filter(w =>
        w.length >= 3 &&
        !COMMON_CAPITALIZED.has(w.toLowerCase()) &&
        !configured.has(w.toLowerCase()) &&
        !ignoredValues.has(w.toLowerCase())
      );

      if (properWords.length < 2) continue; // need at least 2 proper words

      const value = properWords.join(' ');
      if (value.length >= 5 && !configured.has(value.toLowerCase()) && !ignoredValues.has(value.toLowerCase())) {
        findings.push({
          name: 'Possible Name/Org',
          value,
          hint: 'Capitalized phrase — could be a name, company, or project',
          category: 'name',
        });
      }
    }

    // Deduplicate
    const seen = new Set();
    return findings.filter(f => {
      if (seen.has(f.value)) return false;
      seen.add(f.value);
      return true;
    });
  }

  function autoDetectPPI(text, ident) {
    if (!text || text.length < 5) return [];
    const hasContext = CONTEXT_WORDS_RE.test(text);

    // Build skip set from configured values
    const configured = new Set();
    if (ident) {
      const addAll = (arr, key) => (arr || []).forEach(item => {
        if (item.real) configured.add(item.real.toLowerCase());
        if (item.substitute) configured.add(item.substitute.toLowerCase());
      });
      addAll(ident.names); addAll(ident.emails);
      addAll(ident.usernames); addAll(ident.hostnames); addAll(ident.phones);
    }

    const findings = [];
    for (const pat of PPI_PATTERNS) {
      if (pat.contextRequired && !hasContext) continue;
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(text)) !== null) {
        const val = m[0];
        if (configured.has(val.toLowerCase())) continue;
        if (ignoredValues.has(val.toLowerCase())) continue;
        if (pat.skip && pat.skip.test(val)) continue;
        findings.push({ name: pat.name, value: val, hint: pat.hint, category: pat.cat });
      }
    }

    // Proper noun heuristic — catch names, company names, project names
    // that aren't configured in identity
    const properNouns = detectProperNouns(text, configured);
    findings.push(...properNouns);

    // Deduplicate by value
    const seen = new Set();
    return findings.filter(f => {
      if (seen.has(f.value)) return false;
      seen.add(f.value);
      return true;
    });
  }

  // ============================================================
  // Auto-Detect Warning UI — floating banner
  // ============================================================
  let warningEl = null;
  let warningTimeout = null;

  function showAutoDetectWarning(warnings) {
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = 'ss-autodetect-warning';
      document.body.appendChild(warningEl);
    }

    const items = warnings.slice(0, 5).map(w =>
      `<div class="ss-ad-item">
        <span class="ss-ad-type">${w.name}</span>
        <code class="ss-ad-value">${w.value.length > 30 ? w.value.slice(0, 27) + '...' : w.value}</code>
        <span class="ss-ad-hint">${w.hint}</span>
      </div>`
    ).join('');

    const more = warnings.length > 5 ? `<div class="ss-ad-more">+${warnings.length - 5} more</div>` : '';

    safeHTML(warningEl, `
      <div class="ss-ad-header">
        <strong>Silent Send detected potential PPI that may not be substituted:</strong>
        <button class="ss-ad-close">&times;</button>
      </div>
      ${items}
      ${more}
      <div class="ss-ad-footer">${settings.autoRedactDetected !== false ? 'Auto-redacted before sending.' : 'These were sent as-is.'} Consider adding them to your identity or mappings.</div>
    `);

    warningEl.classList.add('visible');

    // Close button
    warningEl.querySelector('.ss-ad-close').addEventListener('click', () => {
      warningEl.classList.remove('visible');
    });

    // Auto-dismiss after 15 seconds
    if (warningTimeout) clearTimeout(warningTimeout);
    warningTimeout = setTimeout(() => {
      warningEl.classList.remove('visible');
    }, 15000);
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
  // Track outbound substitutions — only these get revealed
  //
  // Maps substitute value (lowercase) → real value so reveal
  // only replaces values that were actually sent to the AI,
  // preventing false positives like "user" in AI prose.
  // ============================================================
  const sessionSubstitutions = new Map();

  // Values the user has explicitly ignored via the "Ignore" button.
  // Persisted to storage so they stay dismissed across page reloads.
  const ignoredValues = new Set();

  // Load ignored values from storage
  (async () => {
    const stored = await getStorageData('ss_ignored_ppi');
    if (Array.isArray(stored)) {
      for (const v of stored) ignoredValues.add(v.toLowerCase());
    }
  })();

  function addIgnoredValue(value) {
    ignoredValues.add(value.toLowerCase());
    // Persist
    getStorageData('ss_ignored_ppi').then(stored => {
      const list = Array.isArray(stored) ? stored : [];
      if (!list.includes(value.toLowerCase())) {
        list.push(value.toLowerCase());
        setStorageData('ss_ignored_ppi', list);
      }
    });
  }

  // ============================================================
  // Notify content script of substitutions (for badge + logging)
  // ============================================================
  function notifySubstitutions(replacements) {
    // Record what was actually substituted so reveal knows
    for (const r of replacements) {
      if (r.replaced && r.original) {
        // Store with lowercase key for lookup, but preserve original case
        sessionSubstitutions.set(r.replaced.toLowerCase(), {
          original: r.original,
          replaced: r.replaced,  // preserve original case
        });
      }
    }

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

    // Only intercept POST/PUT/PATCH with a body
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
      options?.body &&
      !shouldSkipUrl(urlStr)
    ) {
      // Handle FormData with file uploads
      if (options.body instanceof FormData) {
        try {
          const newFormData = await processFormData(options.body);
          if (newFormData) {
            options = { ...options, body: newFormData };
          }
        } catch (e) {
          console.warn('[Silent Send] FormData processing failed:', e);
        }
      }
      // Handle string bodies (JSON, raw text)
      else if (typeof options.body === 'string') {
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
    }

    return originalFetch.call(this, url, options);
  };

  // ============================================================
  // Document Upload Processing
  //
  // Scans files in FormData uploads for PPI. Supports PDF, DOCX,
  // XLSX, and text files. Shows preview for binary formats.
  // ============================================================

  async function processFormData(formData) {
    let modified = false;
    const newFormData = new FormData();
    const allReplacements = [];

    for (const [key, value] of formData.entries()) {
      if (value instanceof File && value.size > 0) {
        // Process the file through document scanner
        const usePreview = settings.docScanPreview !== false &&
          /\.(pdf|docx|xlsx)$/i.test(value.name);

        const result = await documentScan(value, value.name, {
          previewMode: usePreview,
        });

        if (result.preview && usePreview && result.replacements.length > 0) {
          // Show preview and wait for user confirmation
          const confirmed = await showDocScanPreview(result.preview, value.name);
          if (!confirmed) {
            // User cancelled — use original file
            newFormData.append(key, value);
            continue;
          }
        }

        if (result.replacements.length > 0 && !result.skipped) {
          let uploadFile = result.file;

          // If preview was confirmed and we have sanitized text, use it
          if (result._sanitizedText) {
            uploadFile = new Blob([result._sanitizedText], { type: 'text/plain' });
          }

          const newFile = new File([uploadFile], result.filename || value.name, {
            type: uploadFile.type || value.type,
          });
          newFormData.append(key, newFile);
          allReplacements.push(...result.replacements);
          modified = true;
          console.log(
            `[Silent Send] Substituted ${result.replacements.length} value(s) in file: ${value.name}`
          );
        } else {
          newFormData.append(key, value);
        }
      } else if (typeof value === 'string') {
        // String form field — substitute
        const result = substituteAll(value);
        if (result.modified) {
          newFormData.append(key, result.text);
          allReplacements.push(...result.replacements);
          modified = true;
        } else {
          newFormData.append(key, value);
        }
      } else {
        newFormData.append(key, value);
      }
    }

    if (modified) {
      notifySubstitutions(allReplacements);
      return newFormData;
    }
    return null;
  }

  /**
   * Scan a document file for PPI. Strategy: extract text from any
   * format, substitute PPI, upload as plaintext. The AI extracts text
   * from files anyway — no need to preserve formatting in a file
   * the user never gets back. Original stays untouched on disk.
   *
   * Supported: PDF, DOCX, DOC, XLSX, XLS, ODT, ODS, ODP, PPTX, RTF,
   * and all text/code formats.
   */
  async function documentScan(file, filename, options) {
    const ext = (filename || '').split('.').pop().toLowerCase();

    // Plain text formats — direct substitution, keep original extension
    const textExts = new Set(['txt','csv','tsv','json','md','markdown','log',
      'yaml','yml','toml','ini','cfg','conf','xml','html','htm','css',
      'js','ts','py','rb','go','rs','java','c','cpp','h','hpp','sh',
      'bash','zsh','ps1','bat','sql','r','swift','kt','scala','pl','php',
      'lua','vim','env','gitignore']);

    if (textExts.has(ext)) {
      const text = await file.text();
      const result = substituteAll(text);
      if (result.modified) {
        return {
          file: new Blob([result.text], { type: file.type || 'text/plain' }),
          filename, replacements: result.replacements,
        };
      }
      return { file, filename, replacements: [] };
    }

    // Binary document formats — extract text, substitute, upload as .txt
    const docExts = new Set(['pdf','docx','doc','xlsx','xls','odt','ods',
      'odp','rtf','pptx']);

    if (!docExts.has(ext)) {
      return { file, filename, replacements: [], skipped: true };
    }

    try {
      const text = await extractTextFromDocument(file, ext);

      if (!text || text.trim().length < 5) {
        return { file, filename, replacements: [], skipped: true,
          reason: `No extractable text in ${ext.toUpperCase()} (may be scanned/image-only)` };
      }

      const result = substituteAll(text);
      const preview = {
        format: ext,
        replacementCount: result.replacements.length,
        replacements: result.replacements.slice(0, 15),
        note: `${ext.toUpperCase()} text extracted and sanitized for upload`,
      };

      if (options.previewMode && result.replacements.length > 0) {
        return { file, filename, replacements: result.replacements, preview,
          _sanitizedText: result.text };
      }

      if (result.modified) {
        return {
          file: new Blob([result.text], { type: 'text/plain' }),
          filename: filename.replace(/\.[^.]+$/, '.txt'),
          replacements: result.replacements, preview,
        };
      }
      return { file, filename, replacements: [] };
    } catch (e) {
      console.warn(`[Silent Send] ${ext.toUpperCase()} processing failed:`, e);
      return { file, filename, replacements: [], skipped: true, reason: e.message };
    }
  }

  /**
   * Extract text from any supported document format.
   */
  async function extractTextFromDocument(file, ext) {
    switch (ext) {
      case 'pdf': return extractPDFText(file);
      case 'docx': case 'xlsx': case 'pptx':
      case 'odt': case 'ods': case 'odp':
        return extractZipXMLText(file, ext);
      case 'doc': case 'xls':
        return extractOldBinaryText(file);
      case 'rtf':
        return extractRTFText(file);
      default: return '';
    }
  }

  /** PDF: extract text from content stream operators (Tj, TJ). */
  async function extractPDFText(file) {
    const buffer = await file.arrayBuffer();
    const str = new TextDecoder('latin1').decode(new Uint8Array(buffer));
    const texts = [];
    const re = /stream\r?\n([\s\S]*?)endstream/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const content = m[1];
      const parts = [];
      const tj = /\(([^)]*)\)\s*Tj/g;
      let t;
      while ((t = tj.exec(content)) !== null) {
        parts.push(t[1].replace(/\\([nrt\\()])/g, (_, c) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
      }
      const tjArr = /\[(.*?)\]\s*TJ/g;
      while ((t = tjArr.exec(content)) !== null) {
        const inner = /\(([^)]*)\)/g;
        let s;
        while ((s = inner.exec(t[1])) !== null) parts.push(s[1]);
      }
      if (parts.length) texts.push(parts.join(''));
    }
    return texts.join('\n');
  }

  /**
   * DOCX/XLSX/PPTX/ODT/ODS/ODP: extract text from ZIP XML entries.
   */
  async function extractZipXMLText(file, ext) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const texts = [];

    // Scan for ZIP local file headers
    let pos = 0;
    while (pos < bytes.length - 30) {
      if (bytes[pos] !== 0x50 || bytes[pos+1] !== 0x4b ||
          bytes[pos+2] !== 0x03 || bytes[pos+3] !== 0x04) {
        pos++; continue;
      }
      const view = new DataView(buffer, pos);
      const compMethod = view.getUint16(8, true);
      const compSize = view.getUint32(18, true);
      const nameLen = view.getUint16(26, true);
      const extraLen = view.getUint16(28, true);
      const name = new TextDecoder().decode(bytes.slice(pos + 30, pos + 30 + nameLen));
      const dataStart = pos + 30 + nameLen + extraLen;
      const rawData = bytes.slice(dataStart, dataStart + compSize);

      if (isTextXML(name, ext) && compSize > 0) {
        let xmlStr;
        try {
          if (compMethod === 8) {
            const dec = await inflateData(rawData);
            xmlStr = dec ? new TextDecoder('utf-8').decode(dec) : null;
          } else if (compMethod === 0) {
            xmlStr = new TextDecoder('utf-8').decode(rawData);
          }
        } catch { /* skip */ }
        if (xmlStr) {
          const re2 = />([^<]+)</g;
          let m2;
          while ((m2 = re2.exec(xmlStr)) !== null) {
            const t = m2[1].trim();
            if (t.length >= 2 && !/^[\x00-\x1f]+$/.test(t)) texts.push(t);
          }
        }
      }
      pos = dataStart + compSize;
    }
    return texts.join(' ');
  }

  function isTextXML(name, ext) {
    switch (ext) {
      case 'docx': return /^word\/(document|header|footer|comments|endnotes|footnotes)/i.test(name);
      case 'xlsx': return name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet/i.test(name);
      case 'pptx': return /^ppt\/slides\/slide/i.test(name);
      case 'odt': case 'odp': return name === 'content.xml' || name === 'styles.xml';
      case 'ods': return name === 'content.xml';
      default: return name.endsWith('.xml');
    }
  }

  /** Old binary .doc/.xls: extract readable text runs. */
  async function extractOldBinaryText(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const texts = [];
    // UTF-16LE extraction (Word stores text as UTF-16)
    let cur = '';
    for (let i = 0; i < bytes.length - 1; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if (code >= 32 && code < 127) { cur += String.fromCharCode(code); }
      else { if (cur.length >= 3) texts.push(cur); cur = ''; }
    }
    if (cur.length >= 3) texts.push(cur);
    // ASCII fallback
    cur = '';
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 32 && bytes[i] < 127) { cur += String.fromCharCode(bytes[i]); }
      else { if (cur.length >= 4) texts.push(cur); cur = ''; }
    }
    if (cur.length >= 4) texts.push(cur);
    const seen = new Set();
    return texts.filter(t => {
      if (seen.has(t)) return false;
      seen.add(t);
      return t.includes(' ') || t.length >= 8;
    }).join(' ');
  }

  /** RTF: strip formatting, extract text. */
  async function extractRTFText(file) {
    const text = await file.text();
    return text
      .replace(/\{\\[^{}]*\}/g, '')
      .replace(/\\[a-z]+\d*\s?/gi, '')
      .replace(/[{}]/g, '')
      .replace(/\\\\/g, '\\')
      .replace(/\\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .trim();
  }

  /** Decompress DEFLATE data using DecompressionStream API. */
  async function inflateData(data) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data); writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) { result.set(c, p); p += c.length; }
      return result;
    } catch { return null; }
  }

  // Document Scan Preview UI
  let docPreviewEl = null;

  function showDocScanPreview(preview, filename) {
    return new Promise((resolve) => {
      if (!docPreviewEl) {
        docPreviewEl = document.createElement('div');
        docPreviewEl.className = 'ss-doc-preview';
        document.body.appendChild(docPreviewEl);
      }
      const items = (preview.replacements || []).map(r =>
        `<div class="ss-dp-item">
          <code class="ss-dp-orig">${(r.original || '').length > 25 ? r.original.slice(0, 22) + '...' : r.original}</code>
          <span>&rarr;</span>
          <code class="ss-dp-repl">${r.replaced}</code>
        </div>`
      ).join('');

      safeHTML(docPreviewEl, `
        <div class="ss-dp-header">
          <strong>PPI found in ${esc(filename)}</strong>
          <span class="ss-dp-count">${preview.replacementCount} item(s)</span>
        </div>
        <div class="ss-dp-note">${preview.note || ''}</div>
        <div class="ss-dp-items">${items}</div>
        <div class="ss-dp-actions">
          <button class="ss-dp-btn ss-dp-confirm">Substitute & Upload</button>
          <button class="ss-dp-btn ss-dp-cancel">Upload Original</button>
        </div>
      `);
      docPreviewEl.classList.add('visible');
      const confirm = docPreviewEl.querySelector('.ss-dp-confirm');
      const cancel = docPreviewEl.querySelector('.ss-dp-cancel');
      const cleanup = () => {
        docPreviewEl.classList.remove('visible');
        confirm.removeEventListener('click', onConfirm);
        cancel.removeEventListener('click', onCancel);
      };
      const onConfirm = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      confirm.addEventListener('click', onConfirm);
      cancel.addEventListener('click', onCancel);
      setTimeout(() => {
        if (docPreviewEl.classList.contains('visible')) { cleanup(); resolve(false); }
      }, 30000);
    });
  }

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
  // Highlighting — CSS Custom Highlight API (zero DOM changes)
  //
  // Two highlight modes:
  //   ss-substituted (yellow) — fake values the AI received
  //   ss-revealed (terminal: dark bg, green text) — your real data
  //
  // Falls back to simple text replacement for reveal if
  // CSS.highlights is not supported.
  // ============================================================

  const hasHighlightAPI = typeof CSS !== 'undefined' && CSS.highlights;

  // Register highlight groups
  let hlSubstituted = null;  // yellow — marks fake values in responses
  let hlRevealed = null;     // terminal — marks revealed real values

  if (hasHighlightAPI) {
    hlSubstituted = new Highlight();
    hlRevealed = new Highlight();
    CSS.highlights.set('ss-substituted', hlSubstituted);
    CSS.highlights.set('ss-revealed', hlRevealed);
  }

  // Build pairs: substitute → real
  // Only includes substitutes that were actually sent outbound in this
  // session, preventing false positives (e.g. "user" in AI prose).
  function buildRevealPairs() {
    const pairs = [];

    // Helper: only add if this substitute was actually sent
    function addIfUsed(from, to, caseSensitive) {
      if (!from || !to) return;
      const entry = sessionSubstitutions.get(from.toLowerCase());
      if (entry) {
        pairs.push({ from, to, caseSensitive });
      }
    }

    for (const m of mappings) {
      if (!m.enabled || !m.substitute || !m.real) continue;
      addIfUsed(m.substitute, m.real, m.caseSensitive);
    }

    if (identity) {
      for (const e of (identity.emails || [])) {
        addIfUsed(e.substitute, e.real);
      }
      for (const n of (identity.names || [])) {
        addIfUsed(n.substitute, n.real);
      }
      for (const u of (identity.usernames || [])) {
        addIfUsed(u.substitute, u.real);
      }
      for (const h of (identity.hostnames || [])) {
        addIfUsed(h.substitute, h.real);
      }
      for (const p of (identity.phones || [])) {
        addIfUsed(p.substitute, p.real);
      }
    }

    // Also add auto-detect and secret scanner substitutions from this session
    for (const [key, entry] of sessionSubstitutions) {
      if (!pairs.some(p => p.from.toLowerCase() === key)) {
        pairs.push({ from: entry.replaced, to: entry.original });
      }
    }

    pairs.sort((a, b) => b.from.length - a.from.length);
    return pairs;
  }

  // Cache — invalidate when config changes or new substitutions happen
  let _revealPairsCache = null;
  let _revealPairsCacheSize = 0;
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'ss:config-updated') _revealPairsCache = null;
    if (event.data?.type === 'ss:substitution-performed') _revealPairsCache = null;
  });

  function getRevealPairs() {
    if (!_revealPairsCache) _revealPairsCache = buildRevealPairs();
    return _revealPairsCache;
  }

  // --- Text replacement for reveal (needed regardless of highlight API) ---

  function revealText(text) {
    const pairs = getRevealPairs();
    let result = text;
    for (const p of pairs) {
      const escaped = esc(p.from);
      const regex = new RegExp(escaped, p.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, p.to);
    }
    return result;
  }

  /**
   * Reverse of revealText: replace real values back to substitutes.
   * Used when reveal mode is turned OFF to restore the AI's actual text.
   */
  function unrevealText(text) {
    const pairs = getRevealPairs();
    let result = text;
    // Reverse direction: real (p.to) → substitute (p.from)
    // Sort by length descending to avoid partial matches
    const reversed = [...pairs].sort((a, b) => b.to.length - a.to.length);
    for (const p of reversed) {
      const escaped = esc(p.to);
      const regex = new RegExp(escaped, p.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, p.from);
    }
    return result;
  }

  function revealInElement(el) {
    if (SKIP_REVEAL_TAGS.has(el.tagName)) return;
    if (el.classList?.contains('ss-reveal-badge')) return;
    // Never touch contenteditable elements (chat input boxes)
    if (el.isContentEditable) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && SKIP_REVEAL_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent?.closest?.('.ss-autodetect-warning, .ss-presend-warning, .ss-reveal-badge')) return NodeFilter.FILTER_REJECT;
        if (parent?.closest?.('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      if (!text || text.length < MIN_STRING_LENGTH) continue;

      const revealed = revealText(text);
      if (revealed !== text) {
        textNode.textContent = revealed;
      }
    }
  }

  function unrevealInElement(el) {
    if (SKIP_REVEAL_TAGS.has(el.tagName)) return;
    if (el.isContentEditable) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent?.closest?.('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      if (!text || text.length < MIN_STRING_LENGTH) continue;

      // Actively replace real→substitute (reverse of reveal)
      const unrevealed = unrevealText(text);
      if (unrevealed !== text) {
        textNode.textContent = unrevealed;
      }
    }
  }

  // --- CSS Highlight API — find and highlight matching text ---

  function highlightMatches(root) {
    if (!hasHighlightAPI) return;

    // Clear previous ranges
    hlSubstituted.clear();
    hlRevealed.clear();

    const pairs = getRevealPairs();
    if (pairs.length === 0) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && SKIP_REVEAL_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent?.closest?.('.ss-autodetect-warning, .ss-presend-warning, .ss-reveal-badge')) return NodeFilter.FILTER_REJECT;
        if (parent?.closest?.('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent;
      if (!text || text.length < MIN_STRING_LENGTH) continue;

      for (const p of pairs) {
        const searchTerm = settings.revealMode ? p.to : p.from;
        const escaped = esc(searchTerm);
        // Add word boundaries when the term starts/ends with word chars to
        // prevent partial-word matches (e.g. "aud" inside "Claude")
        const bStart = /^\w/.test(searchTerm) ? '\\b' : '';
        const bEnd = /\w$/.test(searchTerm) ? '\\b' : '';
        const regex = new RegExp(bStart + escaped + bEnd, p.caseSensitive ? 'g' : 'gi');
        let match;

        while ((match = regex.exec(text)) !== null) {
          try {
            const range = new Range();
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match[0].length);

            if (settings.revealMode) {
              hlRevealed.add(range);
            } else {
              hlSubstituted.add(range);
            }
          } catch (e) {
            // Range may be invalid if DOM changed
          }
        }
      }
    }
  }

  // Elements to skip when revealing (inputs, scripts, styles, extension UI)
  const SKIP_REVEAL_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT',
  ]);

  // Reveal ALL text on the page + apply highlights
  function revealAllResponses() {
    revealInElement(document.body);
    highlightMatches(document.body);
  }

  // Un-reveal ALL text + clear highlights
  function unrevealAllResponses() {
    unrevealInElement(document.body);
    // In non-reveal mode, highlight the fake values instead
    highlightMatches(document.body);
  }

  // Debounced highlight refresh
  let _highlightTimer = null;
  function scheduleHighlightRefresh() {
    if (!hasHighlightAPI) return;
    if (_highlightTimer) clearTimeout(_highlightTimer);
    _highlightTimer = setTimeout(() => {
      highlightMatches(document.body);
    }, 500);
  }

  // Watch for ANY new content on the page
  function observeResponses() {
    const observer = new MutationObserver((mutations) => {
      if (!hasSubstitutions()) return;

      // Always schedule highlight refresh for new content (yellow markers)
      let hasNewContent = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          hasNewContent = true;
          // Only do text replacement in reveal mode
          if (settings.revealMode) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Skip contenteditable (chat input) and skipped tags
              if (!SKIP_REVEAL_TAGS.has(node.tagName) &&
                  !node.isContentEditable &&
                  !node.closest?.('[contenteditable="true"]')) {
                revealInElement(node);
              }
            } else if (node.nodeType === Node.TEXT_NODE) {
              // Skip text nodes inside contenteditable
              const parent = node.parentElement;
              if (parent?.closest?.('[contenteditable="true"]')) continue;
              const text = node.textContent;
              if (text && text.length >= MIN_STRING_LENGTH) {
                const revealed = revealText(text);
                if (revealed !== text) {
                  node.textContent = revealed;
                }
              }
            }
          }
        }

        // Handle streaming text changes
        if (mutation.type === 'characterData') {
          hasNewContent = true;
          if (settings.revealMode) {
            const text = mutation.target.textContent;
            if (text && text.length >= MIN_STRING_LENGTH) {
              const parent = mutation.target.parentElement;
              // Skip contenteditable (chat input)
              if (parent?.closest?.('[contenteditable="true"]')) continue;
              if (parent && !SKIP_REVEAL_TAGS.has(parent.tagName)) {
                const revealed = revealText(text);
                if (revealed !== text) {
                  mutation.target.textContent = revealed;
                }
              }
            }
          }
        }
      }

      if (hasNewContent) scheduleHighlightRefresh();
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
  // Pre-Send PPI Detection — scans as you type/paste (spellcheck style)
  // ============================================================

  // Generate obviously-fake values using reserved/standard ranges
  // These are recognizable as placeholders and guaranteed not to be real
  function generateFake(type, value) {
    switch (type) {
      case 'Private IP':
      case 'Public IP':
        // RFC 5737 — reserved for documentation, never routed
        return '192.0.2.1';
      case 'MAC Address':
        return '00:00:00:00:00:00';
      case 'Street Address':
        return '123 Example Street, Anytown, ST 00000';
      case 'GPS Coordinates':
        return '0.000000,0.000000';
      case 'Date (possible DOB)':
        return '01/01/1970';
      case 'EIN / Tax ID':
        return '00-0000000';
      case 'Home Path':
        if (value.startsWith('C:\\')) return 'C:\\Users\\user';
        if (value.startsWith('/Users/')) return '/Users/user';
        return '/home/user';
      case 'Shell Prompt':
        return 'user@host:$ ';
      case 'Git Remote':
        return value.replace(/[:/][^/\s]+\//, ':/example/');
      case 'Env Variable':
        return value.split('=')[0] + '=REDACTED';
      default:
        return '[REDACTED]';
    }
  }

  // Pre-send warning UI
  let preSendWarningEl = null;
  let preSendTimer = null;

  function showPreSendWarning(warnings, inputEl) {
    if (!preSendWarningEl) {
      preSendWarningEl = document.createElement('div');
      preSendWarningEl.className = 'ss-presend-warning';
      document.body.appendChild(preSendWarningEl);
    }

    const items = warnings.slice(0, 8).map((w, i) => {
      const fake = generateFake(w.name, w.value);
      const displayVal = w.value.length > 25 ? w.value.slice(0, 22) + '...' : w.value;
      return `<div class="ss-ps-item">
        <span class="ss-ps-type">${w.name}</span>
        <code class="ss-ps-value">${displayVal}</code>
        <span class="ss-ps-hint">${w.hint}</span>
        ${settings.autoAddDetected !== false
          ? `<button class="ss-ps-add" data-real="${encodeURIComponent(w.value)}" data-fake="${encodeURIComponent(fake)}" data-cat="${w.category}" title="Add mapping: ${displayVal} → ${fake}">+</button>`
          : ''}
        <button class="ss-ps-ignore" data-value="${encodeURIComponent(w.value)}" title="Never flag this value again">ignore</button>
      </div>`;
    }).join('');

    const more = warnings.length > 8 ? `<div class="ss-ad-more">+${warnings.length - 8} more</div>` : '';

    safeHTML(preSendWarningEl, `
      <div class="ss-ad-header">
        <strong>Potential PPI detected — not yet configured:</strong>
        <button class="ss-ad-close">&times;</button>
      </div>
      ${items}
      ${more}
      <div class="ss-ad-footer">
        ${settings.autoRedactDetected !== false ? 'Auto-redacted with standard placeholders.' : 'These were sent as-is.'}
        ${settings.autoAddDetected !== false ? ' Click + to add a permanent mapping.' : ''}
      </div>
    `);

    preSendWarningEl.classList.add('visible');

    // Close button
    preSendWarningEl.querySelector('.ss-ad-close').addEventListener('click', () => {
      preSendWarningEl.classList.remove('visible');
    });

    // Auto-add buttons
    preSendWarningEl.querySelectorAll('.ss-ps-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const real = decodeURIComponent(btn.dataset.real);
        const fake = decodeURIComponent(btn.dataset.fake);
        const cat = btn.dataset.cat || 'general';

        // Add to mappings via storage
        const result = await getStorageData('ss_mappings');
        const currentMappings = result || [];
        currentMappings.push({
          id: crypto.randomUUID(),
          real, substitute: fake,
          category: cat,
          caseSensitive: false,
          enabled: true,
          createdAt: Date.now(),
        });
        await setStorageData('ss_mappings', currentMappings);

        // Update local mappings so the fetch interceptor uses them immediately
        mappings = currentMappings;

        // Replace the PPI value in the current input right now
        if (inputEl) {
          replaceInInput(inputEl, real, fake);
          // Re-scan — will dismiss warning if no more PPI remains
          if (inputScanTimer) clearTimeout(inputScanTimer);
          inputScanTimer = setTimeout(() => scanInputForPPI(inputEl), 150);
        }

        // Visual feedback
        btn.textContent = '\u2714';
        btn.style.color = '#4ade80';
        btn.disabled = true;
      });
    });

    // Ignore buttons
    preSendWarningEl.querySelectorAll('.ss-ps-ignore').forEach(btn => {
      btn.addEventListener('click', () => {
        const value = decodeURIComponent(btn.dataset.value);
        addIgnoredValue(value);

        // Remove this item's row
        const row = btn.closest('.ss-ps-item');
        if (row) row.remove();

        // Re-scan to update warning
        if (inputEl) {
          if (inputScanTimer) clearTimeout(inputScanTimer);
          inputScanTimer = setTimeout(() => scanInputForPPI(inputEl), 150);
        }
      });
    });
  }

  // Replace all occurrences of `real` with `fake` in an input or contenteditable element
  function replaceInInput(el, real, fake) {
    if (!el) return;
    const re = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (el.value !== undefined) {
      // <textarea> or <input>
      el.value = el.value.replace(re, fake);
    } else if (el.isContentEditable) {
      // contenteditable div — walk text nodes to avoid breaking inner HTML
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        re.lastIndex = 0;
        if (re.test(node.textContent)) {
          re.lastIndex = 0;
          node.textContent = node.textContent.replace(re, fake);
        }
      }
    }
  }

  // Storage helpers for page world (uses postMessage to injector)
  function getStorageData(key) {
    return new Promise(resolve => {
      const id = 'ss-get-' + Math.random();
      const handler = (event) => {
        if (event.data?.type === 'ss:storage-result' && event.data.id === id) {
          window.removeEventListener('message', handler);
          resolve(event.data.value);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'ss:storage-get', key, id }, '*');
      // Timeout fallback
      setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 2000);
    });
  }

  function setStorageData(key, value) {
    window.postMessage({ type: 'ss:storage-set', key, value }, '*');
  }

  // Scan input on type and paste
  let inputScanTimer = null;

  function scanInputForPPI(target) {
    const text = target.textContent || target.value || '';
    if (!text || text.length < 5) {
      if (preSendWarningEl) preSendWarningEl.classList.remove('visible');
      return;
    }

    const warnings = autoDetectPPI(text, identity);
    if (warnings.length > 0) {
      showPreSendWarning(warnings, target);
    } else if (preSendWarningEl) {
      preSendWarningEl.classList.remove('visible');
    }
  }

  document.addEventListener('input', (e) => {
    if (settings.autoDetect === false) return;
    const target = e.target;
    if (target.matches?.('[contenteditable], textarea, input[type="text"]')) {
      // Debounce — don't scan on every keystroke
      if (inputScanTimer) clearTimeout(inputScanTimer);
      inputScanTimer = setTimeout(() => scanInputForPPI(target), 800);
    }
  }, true);

  document.addEventListener('paste', (e) => {
    if (settings.autoDetect === false) return;
    const target = e.target;
    if (target.matches?.('[contenteditable], textarea, input[type="text"]') ||
        target.closest?.('[contenteditable]')) {
      // Scan shortly after paste completes
      setTimeout(() => scanInputForPPI(target.closest?.('[contenteditable]') || target), 200);
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
