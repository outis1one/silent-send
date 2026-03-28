/**
 * Silent Send - Auto-Detect
 *
 * Scans text for potential PPI that the user hasn't configured.
 * This catches things the identity and auto-redact scanner can't —
 * because the user forgot or didn't know to configure them.
 *
 * Returns warnings (not auto-redactions) so the user can decide.
 */

const PPI_PATTERNS = [
  // --- Network ---
  {
    name: 'Private IP Address',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    category: 'network',
    hint: 'Private/local IP address',
  },
  {
    name: 'Public IP Address',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    category: 'network',
    hint: 'IP address — could identify your network',
    // Exclude common non-PPI IPs
    exclude: /^(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+|8\.8\.[84]\.[84]|1\.1\.1\.1|1\.0\.0\.1)$/,
  },
  {
    name: 'IPv6 Address',
    regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    category: 'network',
    hint: 'IPv6 address',
  },
  {
    name: 'MAC Address',
    regex: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
    category: 'network',
    hint: 'MAC address — identifies your hardware',
  },

  // --- Location / Address ---
  {
    name: 'US Street Address',
    regex: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place|Cir|Circle)\.?\b/gi,
    category: 'address',
    hint: 'Looks like a street address',
  },
  {
    name: 'US Zip Code',
    regex: /\b\d{5}(?:-\d{4})?\b/g,
    category: 'address',
    hint: 'Could be a zip code',
    // Only flag if near address-like context
    contextRequired: true,
  },
  {
    name: 'GPS Coordinates',
    regex: /\b-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/g,
    category: 'address',
    hint: 'GPS coordinates — pinpoints a location',
  },

  // --- Identity Documents ---
  {
    name: 'US Passport Number',
    regex: /\b[A-Z]\d{8}\b/g,
    category: 'document',
    hint: 'Could be a passport number',
    contextRequired: true,
  },
  {
    name: 'US Driver License',
    regex: /\b[A-Z]\d{7,14}\b/g,
    category: 'document',
    hint: 'Could be a driver license number',
    contextRequired: true,
  },
  {
    name: 'Date of Birth Pattern',
    regex: /\b(?:(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}|(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01]))\b/g,
    category: 'personal',
    hint: 'Date — could be a birthday or other personal date',
  },
  {
    name: 'EIN / Tax ID',
    regex: /\b\d{2}-\d{7}\b/g,
    category: 'document',
    hint: 'Could be an EIN or tax ID number',
  },

  // --- URLs with usernames ---
  {
    name: 'URL with Username',
    regex: /https?:\/\/[^\s]*(?:user|profile|account|member)[^\s]*/gi,
    category: 'url',
    hint: 'URL that may contain your identity',
  },
  {
    name: 'Git Remote with Username',
    regex: /(?:git@|https:\/\/)(?:github|gitlab|bitbucket)\.[a-z]+[:/][^\s]+/gi,
    category: 'url',
    hint: 'Git remote — may reveal your username/org',
  },

  // --- File paths with home dirs (if not already caught by smart patterns) ---
  {
    name: 'Home Directory Path',
    regex: /(?:\/home\/|\/Users\/|C:\\Users\\)[a-zA-Z0-9._-]+/g,
    category: 'path',
    hint: 'Home directory path — reveals your username',
  },

  // --- Environment Variables with Sensitive Values ---
  {
    name: 'Env Variable Assignment',
    regex: /\b(?:HOME|USER|USERNAME|LOGNAME|HOSTNAME|COMPUTERNAME|EMAIL)=\S+/gi,
    category: 'env',
    hint: 'Environment variable with personal data',
  },

  // --- Shell Prompts ---
  {
    name: 'Shell Prompt',
    regex: /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[:\$#%>]\s/g,
    category: 'prompt',
    hint: 'Shell prompt — reveals username and hostname',
  },
];

// Context words that make ambiguous patterns more likely to be PPI
const CONTEXT_WORDS = /\b(?:born|birthday|dob|birth|passport|license|driver|ssn|social\s*security|address|home|live|lives|reside|zip|postal)\b/i;

const AutoDetect = {
  /**
   * Scan text for potential unconfigured PPI.
   * Pass in identity so we can skip values the user already configured.
   *
   * Returns array of { name, value, hint, category, index }
   */
  scan(text, identity) {
    if (!text || text.length < 5) return [];

    const hasContext = CONTEXT_WORDS.test(text);
    const findings = [];

    // Build a set of already-configured values to skip
    const configured = new Set();
    if (identity) {
      for (const n of (identity.names || [])) {
        if (n.real) configured.add(n.real.toLowerCase());
        if (n.substitute) configured.add(n.substitute.toLowerCase());
      }
      for (const e of (identity.emails || [])) {
        if (e.real) configured.add(e.real.toLowerCase());
        if (e.substitute) configured.add(e.substitute.toLowerCase());
      }
      for (const u of (identity.usernames || [])) {
        if (u.real) configured.add(u.real.toLowerCase());
        if (u.substitute) configured.add(u.substitute.toLowerCase());
      }
      for (const h of (identity.hostnames || [])) {
        if (h.real) configured.add(h.real.toLowerCase());
        if (h.substitute) configured.add(h.substitute.toLowerCase());
      }
      for (const p of (identity.phones || [])) {
        if (p.real) configured.add(p.real.toLowerCase());
        if (p.substitute) configured.add(p.substitute.toLowerCase());
      }
    }

    for (const pattern of PPI_PATTERNS) {
      // Skip context-dependent patterns if no context words present
      if (pattern.contextRequired && !hasContext) continue;

      pattern.regex.lastIndex = 0;
      let match;

      while ((match = pattern.regex.exec(text)) !== null) {
        const value = match[0];

        // Skip if already configured
        if (configured.has(value.toLowerCase())) continue;

        // Skip excluded values (like 127.0.0.1)
        if (pattern.exclude && pattern.exclude.test(value)) continue;

        findings.push({
          name: pattern.name,
          value,
          hint: pattern.hint,
          category: pattern.category,
          index: match.index,
        });
      }
    }

    // Proper noun heuristic — catch names, company names, project names
    const properNouns = this._detectProperNouns(text, configured);
    findings.push(...properNouns);

    // Deduplicate overlapping matches
    findings.sort((a, b) => (a.index || 0) - (b.index || 0));
    const deduped = [];
    let lastEnd = -1;
    for (const f of findings) {
      const idx = f.index || 0;
      if (idx >= lastEnd) {
        deduped.push(f);
        lastEnd = idx + f.value.length;
      }
    }

    return deduped;
  },

  /**
   * Detect capitalized words mid-sentence that might be proper nouns
   * (names, company names, project names) not in the configured set.
   */
  _detectProperNouns(text, configured) {
    const findings = [];
    // Only match TWO OR MORE consecutive capitalized words
    // Single capitalized words cause too many false positives (sentence starts)
    const re = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;
    let m;

    while ((m = re.exec(text)) !== null) {
      const fullMatch = m[1];
      if (!fullMatch) continue;

      const words = fullMatch.split(/\s+/);
      const properWords = words.filter(w =>
        w.length >= 3 &&
        !COMMON_WORDS.has(w.toLowerCase()) &&
        !configured.has(w.toLowerCase())
      );

      if (properWords.length < 2) continue; // need at least 2 proper words

      const value = properWords.join(' ');
      if (value.length >= 5 && !configured.has(value.toLowerCase())) {
        findings.push({
          name: 'Possible Name/Org',
          value,
          hint: 'Capitalized phrase — could be a name, company, or project',
          category: 'name',
        });
      }
    }

    const seen = new Set();
    return findings.filter(f => {
      if (seen.has(f.value)) return false;
      seen.add(f.value);
      return true;
    });
  },
};

// Common English words to exclude from proper noun detection
// Comprehensive list including verbs, nouns, adjectives that appear
// in titles, headings, UI buttons, and instructions
const COMMON_WORDS = new Set([
  'the', 'and', 'but', 'for', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'are', 'has', 'his', 'how', 'its', 'may',
  'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say',
  'she', 'too', 'use', 'also', 'back', 'been', 'call', 'came', 'come',
  'could', 'each', 'even', 'find', 'from', 'give', 'good', 'great',
  'have', 'here', 'high', 'into', 'just', 'keep', 'know', 'last', 'like',
  'live', 'long', 'look', 'made', 'make', 'many', 'more', 'most', 'much',
  'must', 'name', 'next', 'only', 'over', 'part', 'people', 'place',
  'same', 'show', 'side', 'since', 'some', 'still', 'such', 'take',
  'tell', 'than', 'that', 'them', 'then', 'there', 'these', 'they',
  'this', 'time', 'turn', 'used', 'very', 'want', 'well', 'were',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'work',
  'would', 'year', 'your', 'about', 'after', 'again', 'being', 'between',
  'both', 'before', 'down', 'during', 'first', 'found', 'group',
  'however', 'important', 'large', 'later', 'little', 'never',
  'number', 'other', 'point', 'right', 'small', 'state', 'thing',
  'think', 'those', 'three', 'through', 'under', 'until', 'water',
  'world', 'write', 'might', 'should', 'because', 'although',
  // Common verbs (titles, headings, buttons, instructions)
  'generate', 'design', 'manage', 'process', 'handle', 'check', 'verify',
  'submit', 'apply', 'accept', 'reject', 'approve', 'deny', 'confirm',
  'cancel', 'delete', 'remove', 'edit', 'modify', 'view', 'display',
  'search', 'filter', 'sort', 'select', 'choose', 'pick', 'enter',
  'upload', 'download', 'install', 'enable', 'disable', 'activate',
  'connect', 'disconnect', 'sync', 'refresh', 'reload', 'reset',
  'save', 'load', 'store', 'restore', 'backup', 'copy', 'paste',
  'lock', 'unlock', 'encrypt', 'decrypt', 'sign', 'register', 'login',
  'logout', 'subscribe', 'share', 'publish', 'deploy', 'launch',
  'merge', 'split', 'join', 'link', 'attach', 'insert', 'append',
  'format', 'parse', 'convert', 'transform', 'translate', 'compile',
  'execute', 'render', 'animate', 'validate', 'sanitize', 'escape',
  'create', 'build', 'start', 'stop', 'open', 'close', 'run', 'send',
  // Common nouns (titles, headings, labels)
  'account', 'action', 'address', 'alert', 'analysis', 'application',
  'area', 'article', 'asset', 'background', 'badge', 'banner', 'board',
  'body', 'border', 'bottom', 'box', 'browser', 'buffer', 'button',
  'cache', 'calendar', 'card', 'category', 'center', 'channel', 'chart',
  'chat', 'child', 'choice', 'client', 'cloud', 'code', 'collection',
  'color', 'column', 'command', 'comment', 'community', 'company',
  'component', 'config', 'configuration', 'connection', 'console',
  'contact', 'container', 'content', 'context', 'control', 'count',
  'country', 'custom', 'dashboard', 'data', 'database', 'date', 'day',
  'default', 'description', 'design', 'desktop', 'detail', 'device',
  'dialog', 'directory', 'document', 'domain', 'draft', 'driver',
  'edge', 'editor', 'element', 'email', 'engine', 'entry', 'environment',
  'error', 'event', 'example', 'extension', 'feature', 'feedback',
  'field', 'file', 'filter', 'folder', 'font', 'footer', 'form',
  'frame', 'function', 'gallery', 'general', 'global', 'grid',
  'guide', 'handler', 'header', 'health', 'help', 'history', 'home',
  'host', 'icon', 'image', 'index', 'info', 'input', 'instance',
  'interface', 'issue', 'item', 'job', 'key', 'label', 'language',
  'layout', 'level', 'library', 'light', 'limit', 'line', 'link',
  'list', 'local', 'location', 'log', 'logo', 'main', 'manager',
  'manual', 'map', 'media', 'member', 'memory', 'menu', 'message',
  'method', 'mobile', 'modal', 'mode', 'model', 'module', 'monitor',
  'navigation', 'network', 'node', 'note', 'notification', 'object',
  'option', 'order', 'origin', 'output', 'overlay', 'overview', 'owner',
  'package', 'page', 'panel', 'parent', 'parser', 'password', 'path',
  'pattern', 'permission', 'photo', 'pipeline', 'placeholder', 'plan',
  'platform', 'player', 'plugin', 'point', 'policy', 'pool', 'popup',
  'port', 'position', 'post', 'power', 'preview', 'primary', 'print',
  'priority', 'process', 'product', 'profile', 'program', 'progress',
  'project', 'prompt', 'property', 'protocol', 'provider', 'proxy',
  'public', 'query', 'queue', 'quick', 'range', 'rate', 'reader',
  'record', 'region', 'release', 'remote', 'report', 'request',
  'resource', 'response', 'result', 'review', 'role', 'root', 'route',
  'row', 'rule', 'runtime', 'sample', 'scanner', 'schema', 'scope',
  'screen', 'script', 'search', 'section', 'security', 'select',
  'sender', 'server', 'service', 'session', 'setting', 'settings',
  'setup', 'share', 'shell', 'shortcut', 'sidebar', 'signal', 'simple',
  'single', 'site', 'size', 'slider', 'snapshot', 'socket', 'solution',
  'source', 'space', 'stage', 'standard', 'status', 'step', 'storage',
  'stream', 'string', 'style', 'subject', 'success', 'summary',
  'support', 'switch', 'symbol', 'syntax', 'system', 'table', 'target',
  'task', 'team', 'template', 'terminal', 'test', 'text', 'theme',
  'thread', 'title', 'token', 'tool', 'toolbar', 'tooltip', 'total',
  'track', 'traffic', 'tree', 'trigger', 'type', 'unit', 'update',
  'upload', 'user', 'utility', 'value', 'variable', 'version', 'video',
  'view', 'virtual', 'warning', 'watch', 'web', 'widget', 'width',
  'window', 'wizard', 'word', 'worker', 'workspace', 'wrapper', 'zone',
  // Common adjectives
  'active', 'advanced', 'available', 'basic', 'clean', 'clear', 'complete',
  'connected', 'correct', 'critical', 'current', 'dark', 'deep',
  'different', 'direct', 'double', 'dynamic', 'easy', 'empty', 'entire',
  'exact', 'extra', 'fast', 'final', 'fixed', 'flat', 'free', 'fresh',
  'full', 'generic', 'given', 'hidden', 'initial', 'inner', 'internal',
  'invalid', 'latest', 'live', 'major', 'maximum', 'minimum', 'minor',
  'mixed', 'modern', 'multiple', 'native', 'natural', 'nested', 'normal',
  'online', 'optional', 'outer', 'overall', 'partial', 'pending', 'plain',
  'popular', 'possible', 'previous', 'private', 'proper', 'protected',
  'random', 'raw', 'ready', 'real', 'recent', 'related', 'relative',
  'required', 'responsive', 'safe', 'secure', 'selected', 'sensitive',
  'separate', 'shared', 'silent', 'similar', 'smart', 'smooth', 'solid',
  'special', 'specific', 'stable', 'static', 'strict', 'strong',
  'supported', 'unique', 'universal', 'unknown', 'upper', 'valid',
  'various', 'visible', 'visual', 'whole', 'wide',
  // Programming / tech terms
  'string', 'number', 'boolean', 'object', 'array', 'function', 'class',
  'type', 'error', 'null', 'undefined', 'true', 'false', 'return',
  'import', 'export', 'default', 'const', 'async', 'await',
  'note', 'example', 'warning', 'step', 'option', 'result', 'value',
  'key', 'data', 'info', 'file', 'code', 'test', 'debug', 'config',
  'setup', 'update', 'please', 'thanks', 'hello', 'sorry',
  // Days and months
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

if (typeof globalThis !== 'undefined') {
  globalThis.AutoDetect = AutoDetect;
}

export default AutoDetect;
