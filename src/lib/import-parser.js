/**
 * Silent Send - Import Parser
 *
 * Parses bulk import files to pre-populate identity and mappings.
 *
 * Supported formats:
 *
 * 1. CSV/TSV mappings — two columns: real, substitute
 *    Optional third column: category
 *    Header row auto-detected and skipped.
 *
 * 2. Real-values-only list — one value per line
 *    Imports as identity fields with blank substitutes so the user
 *    can see what needs mapping and fill in fakes.
 *
 * 3. Chrome password CSV export — extracts usernames, names, URLs
 *    Columns: name, url, username, password, note
 *    Passwords are NEVER imported. Only usernames/emails/URLs.
 *
 * 4. Firefox password CSV export — similar to Chrome
 *    Columns: url, username, password, ...
 *
 * 5. Bitwarden CSV export — extracts identity fields
 *    Columns: folder, favorite, type, name, login_uri, login_username, ...
 *
 * 6. 1Password CSV export — extracts identity fields
 *    Various formats, but typically: Title, URL, Username, Password, ...
 *
 * 7. Browser autofill CSV — Chrome's autofill export
 *    Columns vary but typically include: name, email, phone, address
 */

const ImportParser = {
  /**
   * Auto-detect format and parse.
   * Returns { mappings: [], identity: { names, emails, usernames, phones, addresses } }
   */
  parse(text, filename = '') {
    const lower = filename.toLowerCase();

    // Try to detect format from filename
    if (lower.includes('password') || lower.includes('logins')) {
      return this.parsePasswordCSV(text);
    }
    if (lower.includes('bitwarden')) {
      return this.parseBitwardenCSV(text);
    }
    if (lower.includes('1password')) {
      return this.parse1PasswordCSV(text);
    }
    if (lower.includes('autofill') || lower.includes('address')) {
      return this.parseAutofillCSV(text);
    }

    // Auto-detect from content
    const lines = text.trim().split('\n');
    if (lines.length === 0) return this._empty();

    const firstLine = lines[0].toLowerCase();

    // CSV with headers
    if (firstLine.includes('username') || firstLine.includes('password') || firstLine.includes('login')) {
      return this.parsePasswordCSV(text);
    }
    if (firstLine.includes('bitwarden') || firstLine.includes('folder,favorite')) {
      return this.parseBitwardenCSV(text);
    }

    // Check if it's a two-column CSV (real → substitute mapping)
    const hasTwoColumns = lines.some(l => l.includes(',') || l.includes('\t'));
    if (hasTwoColumns) {
      return this.parseMappingCSV(text);
    }

    // Plain list — one value per line (real values only)
    return this.parseValueList(text);
  },

  /**
   * Parse a two-column CSV: real,substitute[,category]
   */
  parseMappingCSV(text) {
    const result = this._empty();
    const lines = text.trim().split('\n');
    const sep = lines[0].includes('\t') ? '\t' : ',';

    for (let i = 0; i < lines.length; i++) {
      const cols = this._splitCSVLine(lines[i], sep);
      if (cols.length < 2) continue;

      const real = cols[0].trim();
      const substitute = cols[1].trim();

      // Skip header row
      if (i === 0 && this._isHeader(real, substitute)) continue;
      if (!real) continue;

      const category = (cols[2] || '').trim().toLowerCase() || this._guessCategory(real);

      result.mappings.push({
        real,
        substitute: substitute || '', // may be blank — needs mapping
        category,
        needsMapping: !substitute,
      });
    }

    return result;
  },

  /**
   * Parse a plain list of real values (one per line).
   * All imported as needing substitutes.
   */
  parseValueList(text) {
    const result = this._empty();
    const lines = text.trim().split('\n');

    for (const line of lines) {
      const value = line.trim();
      if (!value || value.length < 2) continue;

      const category = this._guessCategory(value);

      // Route to identity or mappings based on detected category
      if (category === 'email') {
        result.identity.emails.push({ real: value, substitute: '' });
      } else if (category === 'phone') {
        result.identity.phones.push({ real: value, substitute: '' });
      } else if (category === 'name') {
        result.identity.names.push({ real: value, substitute: '', type: 'first' });
      } else {
        result.mappings.push({ real: value, substitute: '', category, needsMapping: true });
      }
    }

    return result;
  },

  /**
   * Parse Chrome/Firefox password CSV export.
   * NEVER imports passwords — only usernames, emails, and domains.
   */
  parsePasswordCSV(text) {
    const result = this._empty();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return result;

    const headers = this._splitCSVLine(lines[0], ',').map(h => h.trim().toLowerCase());
    const usernameIdx = headers.findIndex(h => h === 'username' || h === 'login_username' || h === 'user');
    const urlIdx = headers.findIndex(h => h === 'url' || h === 'login_uri' || h === 'origin' || h === 'web site');
    const nameIdx = headers.findIndex(h => h === 'name' || h === 'title');

    const seenEmails = new Set();
    const seenUsernames = new Set();
    const seenDomains = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = this._splitCSVLine(lines[i], ',');

      // Extract username/email
      if (usernameIdx >= 0 && cols[usernameIdx]) {
        const username = cols[usernameIdx].trim();
        if (username && !seenEmails.has(username) && !seenUsernames.has(username)) {
          if (username.includes('@')) {
            seenEmails.add(username);
            result.identity.emails.push({ real: username, substitute: '' });
          } else if (username.length >= 3) {
            seenUsernames.add(username);
            result.identity.usernames.push({ real: username, substitute: '' });
          }
        }
      }

      // Extract domain from URL
      if (urlIdx >= 0 && cols[urlIdx]) {
        try {
          const domain = new URL(cols[urlIdx].trim()).hostname;
          if (domain && !seenDomains.has(domain) && !this._isCommonDomain(domain)) {
            seenDomains.add(domain);
            result.mappings.push({
              real: domain,
              substitute: '',
              category: 'domain',
              needsMapping: true,
            });
          }
        } catch { /* invalid URL */ }
      }
    }

    return result;
  },

  /**
   * Parse Bitwarden CSV export.
   */
  parseBitwardenCSV(text) {
    const result = this._empty();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return result;

    const headers = this._splitCSVLine(lines[0], ',').map(h => h.trim().toLowerCase());
    const usernameIdx = headers.findIndex(h => h.includes('username'));
    const uriIdx = headers.findIndex(h => h.includes('uri') || h.includes('url'));

    const seen = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = this._splitCSVLine(lines[i], ',');

      if (usernameIdx >= 0 && cols[usernameIdx]) {
        const val = cols[usernameIdx].trim();
        if (val && !seen.has(val)) {
          seen.add(val);
          if (val.includes('@')) {
            result.identity.emails.push({ real: val, substitute: '' });
          } else if (val.length >= 3) {
            result.identity.usernames.push({ real: val, substitute: '' });
          }
        }
      }

      if (uriIdx >= 0 && cols[uriIdx]) {
        try {
          const domain = new URL(cols[uriIdx].trim()).hostname;
          if (domain && !seen.has(domain) && !this._isCommonDomain(domain)) {
            seen.add(domain);
            result.mappings.push({ real: domain, substitute: '', category: 'domain', needsMapping: true });
          }
        } catch { /* skip */ }
      }
    }

    return result;
  },

  /**
   * Parse 1Password CSV export.
   */
  parse1PasswordCSV(text) {
    // 1Password CSV is similar enough to handle like password CSV
    return this.parsePasswordCSV(text);
  },

  /**
   * Parse browser autofill/address CSV.
   * Extracts names, emails, phones, addresses.
   */
  parseAutofillCSV(text) {
    const result = this._empty();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return result;

    const headers = this._splitCSVLine(lines[0], ',').map(h => h.trim().toLowerCase());

    const nameFields = ['name', 'full name', 'first name', 'last name', 'given name', 'family name'];
    const emailFields = ['email', 'e-mail', 'email address'];
    const phoneFields = ['phone', 'phone number', 'tel', 'telephone'];
    const addressFields = ['address', 'street', 'address line 1', 'street address'];

    const findIdx = (targets) => headers.findIndex(h => targets.some(t => h.includes(t)));

    const nameIdx = findIdx(nameFields);
    const firstNameIdx = headers.findIndex(h => h === 'first name' || h === 'given name');
    const lastNameIdx = headers.findIndex(h => h === 'last name' || h === 'family name');
    const emailIdx = findIdx(emailFields);
    const phoneIdx = findIdx(phoneFields);
    const addressIdx = findIdx(addressFields);

    const seen = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = this._splitCSVLine(lines[i], ',');

      // Names
      if (firstNameIdx >= 0 && cols[firstNameIdx]) {
        const val = cols[firstNameIdx].trim();
        if (val && !seen.has('fn:' + val)) {
          seen.add('fn:' + val);
          result.identity.names.push({ real: val, substitute: '', type: 'first' });
        }
      }
      if (lastNameIdx >= 0 && cols[lastNameIdx]) {
        const val = cols[lastNameIdx].trim();
        if (val && !seen.has('ln:' + val)) {
          seen.add('ln:' + val);
          result.identity.names.push({ real: val, substitute: '', type: 'last' });
        }
      }
      if (nameIdx >= 0 && cols[nameIdx] && firstNameIdx < 0) {
        const val = cols[nameIdx].trim();
        if (val && !seen.has('n:' + val)) {
          seen.add('n:' + val);
          // Split "First Last" into two entries
          const parts = val.split(/\s+/);
          if (parts.length >= 2) {
            result.identity.names.push({ real: parts[0], substitute: '', type: 'first' });
            result.identity.names.push({ real: parts.slice(1).join(' '), substitute: '', type: 'last' });
          } else {
            result.identity.names.push({ real: val, substitute: '', type: 'first' });
          }
        }
      }

      // Emails
      if (emailIdx >= 0 && cols[emailIdx]) {
        const val = cols[emailIdx].trim();
        if (val && !seen.has('e:' + val)) {
          seen.add('e:' + val);
          result.identity.emails.push({ real: val, substitute: '' });
        }
      }

      // Phones
      if (phoneIdx >= 0 && cols[phoneIdx]) {
        const val = cols[phoneIdx].trim();
        if (val && !seen.has('p:' + val)) {
          seen.add('p:' + val);
          result.identity.phones.push({ real: val, substitute: '' });
        }
      }

      // Addresses
      if (addressIdx >= 0 && cols[addressIdx]) {
        const val = cols[addressIdx].trim();
        if (val && !seen.has('a:' + val)) {
          seen.add('a:' + val);
          result.mappings.push({ real: val, substitute: '', category: 'address', needsMapping: true });
        }
      }
    }

    return result;
  },

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  _empty() {
    return {
      mappings: [],
      identity: {
        names: [],
        emails: [],
        usernames: [],
        hostnames: [],
        phones: [],
      },
    };
  },

  _isHeader(a, b) {
    const headers = ['real', 'substitute', 'fake', 'original', 'replacement', 'from', 'to', 'value', 'category', 'type'];
    return headers.includes(a.toLowerCase()) || headers.includes(b.toLowerCase());
  },

  _guessCategory(value) {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return 'email';
    if (/^[\d\s()+.-]{7,}$/.test(value)) return 'phone';
    if (/^\d{3}-\d{2}-\d{4}$/.test(value)) return 'ssn';
    if (/\d{1,5}\s+\w+\s+(st|street|ave|avenue|blvd|dr|drive|rd|road|ln|lane)/i.test(value)) return 'address';
    if (/^[a-z][a-z0-9._-]*$/i.test(value) && value.length >= 3 && value.length <= 20) return 'general';
    if (/^[A-Z][a-z]+(\s[A-Z][a-z]+)*$/.test(value)) return 'name';
    return 'general';
  },

  /**
   * Split a CSV line respecting quoted fields.
   */
  _splitCSVLine(line, sep = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === sep && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);

    // Strip surrounding quotes
    return result.map(s => s.replace(/^"|"$/g, ''));
  },

  _isCommonDomain(domain) {
    const common = new Set([
      'google.com', 'facebook.com', 'twitter.com', 'x.com', 'amazon.com',
      'apple.com', 'microsoft.com', 'github.com', 'youtube.com', 'reddit.com',
      'netflix.com', 'linkedin.com', 'instagram.com', 'wikipedia.org',
      'stackoverflow.com', 'accounts.google.com', 'login.microsoftonline.com',
    ]);
    return common.has(domain);
  },
};

export default ImportParser;
