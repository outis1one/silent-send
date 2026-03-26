/**
 * Silent Send - Secret Scanner
 *
 * Detects common secret/credential patterns in text and either
 * warns or auto-redacts them. This catches things the identity-based
 * smart patterns can't: API keys, tokens, passwords, SSNs, credit
 * cards, private keys, connection strings, etc.
 *
 * Each pattern has:
 *   - name: human-readable label
 *   - regex: detection pattern
 *   - redact: replacement string (or function)
 *   - severity: 'critical' (always redact) or 'warning' (flag but allow)
 */

const SECRET_PATTERNS = [
  // --- API Keys ---
  {
    name: 'OpenAI API Key',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    redact: '[REDACTED-OPENAI-KEY]',
    severity: 'critical',
  },
  {
    name: 'OpenAI Project Key',
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
    redact: '[REDACTED-OPENAI-PROJECT-KEY]',
    severity: 'critical',
  },
  {
    name: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    redact: '[REDACTED-ANTHROPIC-KEY]',
    severity: 'critical',
  },
  {
    name: 'Google API Key',
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    redact: '[REDACTED-GOOGLE-KEY]',
    severity: 'critical',
  },
  {
    name: 'AWS Access Key',
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
    redact: '[REDACTED-AWS-KEY]',
    severity: 'critical',
  },
  {
    name: 'AWS Secret Key',
    regex: /\b[A-Za-z0-9/+=]{40}\b(?=.*aws|.*secret)/gi,
    redact: '[REDACTED-AWS-SECRET]',
    severity: 'critical',
  },
  {
    name: 'GitHub Token',
    regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    redact: '[REDACTED-GITHUB-TOKEN]',
    severity: 'critical',
  },
  {
    name: 'GitLab Token',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    redact: '[REDACTED-GITLAB-TOKEN]',
    severity: 'critical',
  },
  {
    name: 'Slack Token',
    regex: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g,
    redact: '[REDACTED-SLACK-TOKEN]',
    severity: 'critical',
  },
  {
    name: 'Stripe Key',
    regex: /\b[sr]k_(test|live)_[A-Za-z0-9]{20,}\b/g,
    redact: '[REDACTED-STRIPE-KEY]',
    severity: 'critical',
  },
  {
    name: 'Twilio Key',
    regex: /\bSK[a-f0-9]{32}\b/g,
    redact: '[REDACTED-TWILIO-KEY]',
    severity: 'critical',
  },
  {
    name: 'SendGrid Key',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    redact: '[REDACTED-SENDGRID-KEY]',
    severity: 'critical',
  },
  {
    name: 'Heroku API Key',
    regex: /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g,
    redact: null, // UUIDs are too common — flag but don't auto-redact
    severity: 'warning',
  },
  {
    name: 'Generic API Key',
    regex: /\b(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
    redact: (match) => match.replace(/[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}['"]?/, '=[REDACTED]'),
    severity: 'critical',
  },
  {
    name: 'Generic Secret/Password Assignment',
    regex: /\b(?:password|passwd|pwd|secret|token|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    redact: (match) => match.replace(/[:=]\s*['"]?[^\s'"]{8,}['"]?/, '=[REDACTED]'),
    severity: 'critical',
  },
  {
    name: 'Bearer Token',
    regex: /\bBearer\s+[A-Za-z0-9_\-./+=]{20,}\b/g,
    redact: 'Bearer [REDACTED]',
    severity: 'critical',
  },

  // --- Private Keys ---
  {
    name: 'Private Key Block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    redact: '[REDACTED-PRIVATE-KEY]',
    severity: 'critical',
  },

  // --- Connection Strings ---
  {
    name: 'Database Connection String',
    regex: /\b(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"']+/gi,
    redact: (match) => {
      try {
        const url = new URL(match);
        if (url.password) url.password = 'REDACTED';
        if (url.username) url.username = 'REDACTED';
        return url.toString();
      } catch {
        return '[REDACTED-CONNECTION-STRING]';
      }
    },
    severity: 'critical',
  },

  // --- PII Patterns ---
  {
    name: 'US Social Security Number',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    redact: '[REDACTED-SSN]',
    severity: 'critical',
  },
  {
    name: 'Credit Card Number',
    regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
    redact: '[REDACTED-CARD]',
    severity: 'critical',
  },

  // --- Generic Long Hex/Base64 Strings ---
  // Catches things that look like secrets but don't match known prefixes
  {
    name: 'Long Hex String (possible secret)',
    regex: /\b[a-f0-9]{40,}\b/gi,
    redact: null, // Too many false positives — warn only
    severity: 'warning',
  },
];

const SecretScanner = {
  /**
   * Scan text for secrets. Returns list of findings.
   */
  scan(text) {
    const findings = [];

    for (const pattern of SECRET_PATTERNS) {
      // Reset regex lastIndex
      pattern.regex.lastIndex = 0;
      let match;

      while ((match = pattern.regex.exec(text)) !== null) {
        findings.push({
          name: pattern.name,
          value: match[0],
          index: match.index,
          length: match[0].length,
          severity: pattern.severity,
          redactTo: typeof pattern.redact === 'function'
            ? pattern.redact(match[0])
            : pattern.redact,
        });
      }
    }

    // Deduplicate overlapping matches (keep the most specific / longest)
    findings.sort((a, b) => a.index - b.index || b.length - a.length);
    const deduped = [];
    let lastEnd = -1;
    for (const f of findings) {
      if (f.index >= lastEnd) {
        deduped.push(f);
        lastEnd = f.index + f.length;
      }
    }

    return deduped;
  },

  /**
   * Redact all critical secrets in text. Warnings are not auto-redacted.
   * Returns { text, redactions[] }
   */
  redact(text) {
    const findings = this.scan(text);
    const redactions = [];
    let result = text;

    // Process from end to preserve indices
    const critical = findings
      .filter(f => f.severity === 'critical' && f.redactTo)
      .reverse();

    for (const f of critical) {
      result = result.slice(0, f.index) + f.redactTo + result.slice(f.index + f.length);
      redactions.push({
        original: f.value,
        replaced: f.redactTo,
        category: 'secret',
        pattern: f.name,
      });
    }

    // Reverse so they're in order
    redactions.reverse();

    return {
      text: result,
      redactions,
      warnings: findings.filter(f => f.severity === 'warning'),
    };
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.SecretScanner = SecretScanner;
}

export default SecretScanner;
