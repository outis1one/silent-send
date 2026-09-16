/**
 * Silent Send - Substitution Engine
 *
 * Handles bidirectional substitution of personal data.
 * real → fake on outbound messages, fake → real on inbound display.
 */

const SubstitutionEngine = {
  /**
   * Apply all mappings to text (real → substitute).
   * Returns { text, replacements[] } so we can log what happened.
   */
  substitute(text, mappings) {
    const replacements = [];
    let result = text;

    // Sort by length descending so longer matches take priority
    // e.g. "John Smith" matches before "John"
    const sorted = [...mappings].sort(
      (a, b) => b.real.length - a.real.length
    );

    for (const mapping of sorted) {
      if (!mapping.enabled || !mapping.real?.trim() || !mapping.substitute?.trim()) continue;

      const pattern = this._wordBoundaryPattern(mapping.real);
      const regex = new RegExp(pattern, mapping.caseSensitive ? 'g' : 'gi');
      let match;

      while ((match = regex.exec(result)) !== null) {
        replacements.push({
          original: match[0],
          replaced: mapping.substitute,
          index: match.index,
          category: mapping.category || 'general',
          timestamp: Date.now(),
        });
      }

      result = result.replace(regex, mapping.substitute);
    }

    return { text: result, replacements };
  },

  /**
   * Reverse substitution (substitute → real) for inbound display.
   */
  reveal(text, mappings) {
    let result = text;

    const sorted = [...mappings].sort(
      (a, b) => b.substitute.length - a.substitute.length
    );

    for (const mapping of sorted) {
      if (!mapping.enabled || !mapping.real?.trim() || !mapping.substitute?.trim()) continue;

      const pattern = this._wordBoundaryPattern(mapping.substitute);
      const regex = new RegExp(pattern, mapping.caseSensitive ? 'g' : 'gi');
      result = result.replace(regex, mapping.real);
    }

    return result;
  },

  /**
   * Check if text contains any real values that should be substituted.
   */
  scan(text, mappings) {
    const found = [];

    for (const mapping of mappings) {
      if (!mapping.enabled || !mapping.real?.trim()) continue;

      const pattern = this._wordBoundaryPattern(mapping.real);
      const regex = new RegExp(pattern, mapping.caseSensitive ? 'g' : 'gi');

      if (regex.test(text)) {
        found.push({
          real: mapping.real,
          substitute: mapping.substitute,
          category: mapping.category || 'general',
        });
      }
    }

    return found;
  },

  /**
   * Generate a diff-style comparison between original and substituted text.
   */
  diff(original, substituted, mappings) {
    const chunks = [];
    let i = 0;

    // Simple character-level diff by finding substituted regions
    const sorted = [...mappings].sort(
      (a, b) => b.real.length - a.real.length
    );

    // Collect all match positions in the original text
    const matches = [];
    for (const mapping of sorted) {
      if (!mapping.enabled || !mapping.real?.trim() || !mapping.substitute?.trim()) continue;

      const pattern = this._wordBoundaryPattern(mapping.real);
      const regex = new RegExp(pattern, mapping.caseSensitive ? 'g' : 'gi');
      let match;

      while ((match = regex.exec(original)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          original: match[0],
          substitute: mapping.substitute,
        });
      }
    }

    // Sort by position
    matches.sort((a, b) => a.start - b.start);

    // Build chunks
    for (const m of matches) {
      if (m.start > i) {
        chunks.push({ type: 'unchanged', text: original.slice(i, m.start) });
      }
      chunks.push({
        type: 'substituted',
        original: m.original,
        replacement: m.substitute,
      });
      i = m.end;
    }

    if (i < original.length) {
      chunks.push({ type: 'unchanged', text: original.slice(i) });
    }

    return chunks;
  },

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  // Wrap an escaped literal in \b only on edges that are word characters,
  // so "not" → "bad" matches "not" but not "nothing", while mappings whose
  // edges aren't word chars (e.g. "@foo", "foo.com ") still work.
  _wordBoundaryPattern(str) {
    const escaped = this._escapeRegex(str);
    const left = /^\w/.test(str) ? '\\b' : '';
    const right = /\w$/.test(str) ? '\\b' : '';
    return left + escaped + right;
  },
};

// Support both module and content-script contexts
if (typeof globalThis !== 'undefined') {
  globalThis.SubstitutionEngine = SubstitutionEngine;
}

export default SubstitutionEngine;
