/**
 * Silent Send - Auto-Detect
 *
 * Scans text for potential PPI that the user hasn't configured.
 * This catches things the identity and secret scanner can't —
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
    const re = /(?:^|[.!?\n]\s*)?([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g;
    let m;

    while ((m = re.exec(text)) !== null) {
      const fullMatch = m[1];
      if (!fullMatch) continue;

      const before = text.slice(Math.max(0, m.index - 2), m.index);
      const isSentenceStart = m.index === 0 || /[.!?\n]\s*$/.test(before);

      const words = fullMatch.split(/\s+/);
      const properWords = words.filter(w =>
        w.length >= 3 &&
        !COMMON_WORDS.has(w.toLowerCase()) &&
        !configured.has(w.toLowerCase())
      );

      if (properWords.length === 0) continue;
      if (isSentenceStart && properWords.length === 1 && words.length === 1) continue;

      const value = properWords.join(' ');
      if (value.length >= 3 && !configured.has(value.toLowerCase())) {
        findings.push({
          name: 'Possible Name/Org',
          value,
          hint: 'Capitalized word — could be a name, company, or project',
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
