/**
 * Silent Send - Smart Pattern Detector
 *
 * Automatically detects and substitutes personal data patterns
 * without requiring explicit mappings for every variation.
 *
 * Supported patterns:
 *   - Emails:     anything@recognized-domain → substitute-email
 *   - Names:      First, Last, First Last, LAST (case variants)
 *   - User@Host:  username patterns from system/shell contexts
 *   - Phones:     common formats (xxx) xxx-xxxx, xxx-xxx-xxxx, etc.
 *   - Paths:      /home/username, /Users/username, C:\Users\username
 */

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

const SmartPatterns = {
  /**
   * Process text using smart patterns + identity config.
   * Returns { text, replacements[] } same shape as SubstitutionEngine.
   *
   * @param {string} text - Input text
   * @param {object} identity - User's identity config:
   *   {
   *     emails: [{ real: "john@gmail.com", substitute: "alex@example.com" }],
   *     names: [{ real: "John", substitute: "Alex", type: "first" },
   *             { real: "Smith", substitute: "Demo", type: "last" }],
   *     usernames: [{ real: "jsmith", substitute: "ademo" }],
   *     phones: [{ real: "555-123-4567", substitute: "555-000-0000" }],
   *     catchAllEmail: "anon@example.com",  // fallback for unknown emails with your domain
   *     emailDomains: ["mycompany.com"],     // additional domains to catch
   *     enabled: { emails: true, names: true, usernames: true, phones: true, paths: true }
   *   }
   */
  substitute(text, identity) {
    if (!identity) return { text, replacements: [] };

    const replacements = [];
    let result = text;

    // Order matters: do emails first (most specific), then names, then usernames, then paths
    if (identity.enabled?.emails !== false) {
      const r = this._substituteEmails(result, identity);
      result = r.text;
      replacements.push(...r.replacements);
    }

    if (identity.enabled?.phones !== false) {
      const r = this._substitutePhones(result, identity);
      result = r.text;
      replacements.push(...r.replacements);
    }

    if (identity.enabled?.names !== false) {
      const r = this._substituteNames(result, identity);
      result = r.text;
      replacements.push(...r.replacements);
    }

    if (identity.enabled?.usernames !== false) {
      const r = this._substituteUsernames(result, identity);
      result = r.text;
      replacements.push(...r.replacements);
    }

    if (identity.enabled?.paths !== false) {
      const r = this._substitutePaths(result, identity);
      result = r.text;
      replacements.push(...r.replacements);
    }

    return { text: result, replacements };
  },

  // ----- Emails -----
  // Catches: exact matches, AND any something@known-domain
  _substituteEmails(text, identity) {
    const replacements = [];
    let result = text;

    // Build set of known real emails for exact matching
    const emailMap = new Map();
    for (const e of (identity.emails || [])) {
      emailMap.set(e.real.toLowerCase(), e.substitute);
    }

    // Additional domains to treat as "yours"
    const myDomains = new Set(
      (identity.emailDomains || []).map(d => d.toLowerCase())
    );

    // Match all email-like patterns
    const emailRegex = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
    let match;

    // Collect all matches first, then replace from end to preserve indices
    const matches = [];
    while ((match = emailRegex.exec(result)) !== null) {
      matches.push({ index: match.index, value: match[0] });
    }

    // Process from end to start so indices stay valid
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const lower = m.value.toLowerCase();
      const domain = lower.split('@')[1];

      let replacement = null;

      // Exact match?
      if (emailMap.has(lower)) {
        replacement = emailMap.get(lower);
      }
      // Known personal domain (gmail, etc.) or custom domain?
      else if (
        COMMON_EMAIL_DOMAINS.has(domain) ||
        myDomains.has(domain)
      ) {
        replacement = identity.catchAllEmail || 'user@example.com';
      }

      if (replacement) {
        replacements.push({
          original: m.value,
          replaced: replacement,
          category: 'email',
          pattern: 'smart',
        });
        result =
          result.slice(0, m.index) +
          replacement +
          result.slice(m.index + m.value.length);
      }
    }

    return { text: result, replacements };
  },

  // ----- Names -----
  // Catches: "John Smith", "Smith, John", "John", "Smith", "SMITH", "john"
  // Also catches possessives: "John's", "Smith's"
  _substituteNames(text, identity) {
    const replacements = [];
    let result = text;
    const names = identity.names || [];

    if (names.length === 0) return { text: result, replacements };

    // First pass: full name combinations (first + last)
    const firsts = names.filter(n => n.type === 'first');
    const lasts = names.filter(n => n.type === 'last');

    for (const first of firsts) {
      for (const last of lasts) {
        // "First Last"
        const fullRegex = new RegExp(
          esc(first.real) + "\\s+" + esc(last.real),
          'gi'
        );
        result = result.replace(fullRegex, (matched) => {
          replacements.push({
            original: matched,
            replaced: `${first.substitute} ${last.substitute}`,
            category: 'name',
            pattern: 'smart-fullname',
          });
          return `${first.substitute} ${last.substitute}`;
        });

        // "Last, First"
        const reverseRegex = new RegExp(
          esc(last.real) + ",\\s*" + esc(first.real),
          'gi'
        );
        result = result.replace(reverseRegex, (matched) => {
          replacements.push({
            original: matched,
            replaced: `${last.substitute}, ${first.substitute}`,
            category: 'name',
            pattern: 'smart-fullname-reverse',
          });
          return `${last.substitute}, ${first.substitute}`;
        });
      }
    }

    // Second pass: individual names (with word boundaries)
    for (const name of names) {
      if (!name.real || !name.substitute) continue;

      // Match the name with word boundaries, including possessives
      const nameRegex = new RegExp(
        '\\b' + esc(name.real) + "(?:'s)?\\b",
        'gi'
      );

      result = result.replace(nameRegex, (matched) => {
        const isPossessive = matched.endsWith("'s");
        const sub = isPossessive
          ? name.substitute + "'s"
          : name.substitute;

        replacements.push({
          original: matched,
          replaced: sub,
          category: 'name',
          pattern: 'smart-name',
        });
        return sub;
      });
    }

    return { text: result, replacements };
  },

  // ----- Usernames + Hostnames -----
  // Catches: user@hostname, ~username, /home/username, mentions of username
  // in shell/code contexts. Also substitutes hostnames independently.
  _substituteUsernames(text, identity) {
    const replacements = [];
    let result = text;
    const usernames = identity.usernames || [];
    const hostMap = new Map();
    for (const h of (identity.hostnames || [])) {
      if (h.real && h.substitute) hostMap.set(h.real.toLowerCase(), h);
    }

    for (const u of usernames) {
      if (!u.real || !u.substitute) continue;

      // user@hostname patterns (SSH, terminal prompts)
      const userHostRegex = new RegExp(
        esc(u.real) + '@[a-zA-Z0-9._\\-]+',
        'g'
      );
      result = result.replace(userHostRegex, (matched) => {
        const host = matched.slice(u.real.length + 1);
        // Also substitute hostname if configured
        const hostEntry = hostMap.get(host.toLowerCase());
        const subHost = hostEntry ? hostEntry.substitute : host;
        const sub = u.substitute + '@' + subHost;
        replacements.push({
          original: matched,
          replaced: sub,
          category: 'username',
          pattern: 'smart-userhost',
        });
        return sub;
      });

      // ~username (shell shorthand)
      const tildeRegex = new RegExp('~' + esc(u.real) + '\\b', 'g');
      result = result.replace(tildeRegex, (matched) => {
        const sub = '~' + u.substitute;
        replacements.push({
          original: matched,
          replaced: sub,
          category: 'username',
          pattern: 'smart-tilde',
        });
        return sub;
      });

      // Plain username with word boundaries (careful - short names can over-match)
      // Only match if username is 3+ chars to avoid false positives
      if (u.real.length >= 3) {
        const plainRegex = new RegExp('\\b' + esc(u.real) + '\\b', 'g');
        result = result.replace(plainRegex, (matched) => {
          replacements.push({
            original: matched,
            replaced: u.substitute,
            category: 'username',
            pattern: 'smart-username',
          });
          return u.substitute;
        });
      }
    }

    // Standalone hostname substitution (catches hostnames appearing on their own)
    for (const [, h] of hostMap) {
      if (h.real.length >= 3) {
        const hostRegex = new RegExp('\\b' + esc(h.real) + '\\b', 'gi');
        result = result.replace(hostRegex, (matched) => {
          replacements.push({
            original: matched,
            replaced: h.substitute,
            category: 'hostname',
            pattern: 'smart-hostname',
          });
          return h.substitute;
        });
      }
    }

    return { text: result, replacements };
  },

  // ----- Phones -----
  // Catches common formats: (555) 123-4567, 555-123-4567, 555.123.4567,
  // +1 555 123 4567, 5551234567
  _substitutePhones(text, identity) {
    const replacements = [];
    let result = text;
    const phones = identity.phones || [];

    for (const p of phones) {
      if (!p.real || !p.substitute) continue;

      // Normalize the real phone to just digits
      const digits = p.real.replace(/\D/g, '');
      if (digits.length < 7) continue;

      // Build a regex that matches the digits in any common format
      // For a number like 5551234567, match:
      //   555-123-4567, (555) 123-4567, 555.123.4567, +1-555-123-4567, etc.
      const d = digits.startsWith('1') && digits.length === 11
        ? digits.slice(1)
        : digits;

      if (d.length !== 10 && d.length !== 7) continue;

      let pattern;
      if (d.length === 10) {
        const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6);
        pattern =
          '(?:\\+?1[\\s.-]?)?' +
          '(?:' + esc(a) + '|\\(' + esc(a) + '\\))' +
          '[\\s.\\-]?' +
          esc(b) + '[\\s.\\-]?' + esc(c);
      } else {
        const b = d.slice(0, 3), c = d.slice(3);
        pattern = esc(b) + '[\\s.\\-]?' + esc(c);
      }

      const phoneRegex = new RegExp(pattern, 'g');
      result = result.replace(phoneRegex, (matched) => {
        replacements.push({
          original: matched,
          replaced: p.substitute,
          category: 'phone',
          pattern: 'smart-phone',
        });
        return p.substitute;
      });
    }

    return { text: result, replacements };
  },

  // ----- File Paths -----
  // Catches: /home/username, /Users/username, C:\Users\username
  _substitutePaths(text, identity) {
    const replacements = [];
    let result = text;
    const usernames = identity.usernames || [];

    for (const u of usernames) {
      if (!u.real || !u.substitute) continue;

      // Unix paths: /home/username or /Users/username
      const unixRegex = new RegExp(
        '(/(?:home|Users)/)' + esc(u.real) + '(?=/|\\s|$|"|\')',
        'g'
      );
      result = result.replace(unixRegex, (matched, prefix) => {
        const sub = prefix + u.substitute;
        replacements.push({
          original: matched,
          replaced: sub,
          category: 'path',
          pattern: 'smart-path',
        });
        return sub;
      });

      // Windows paths: C:\Users\username
      const winRegex = new RegExp(
        '([A-Z]:\\\\Users\\\\)' + esc(u.real) + '(?=\\\\|\\s|$|"|\')',
        'gi'
      );
      result = result.replace(winRegex, (matched, prefix) => {
        const sub = prefix + u.substitute;
        replacements.push({
          original: matched,
          replaced: sub,
          category: 'path',
          pattern: 'smart-path-win',
        });
        return sub;
      });
    }

    return { text: result, replacements };
  },
};

function esc(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (typeof globalThis !== 'undefined') {
  globalThis.SmartPatterns = SmartPatterns;
}

export default SmartPatterns;
