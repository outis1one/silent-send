# Privacy Policy — Silent Send

**Last updated:** March 26, 2026

## Summary

Silent Send does not collect, transmit, or store any data externally. All processing happens 100% locally in your browser. There are no servers, no analytics, no tracking, and no telemetry of any kind.

## What data Silent Send accesses

Silent Send accesses the following data **only within your browser** to perform its core function (substituting personal information before it reaches AI services):

- **Text you type** in AI chat interfaces (Claude, ChatGPT, Grok, Gemini, etc.) — scanned for configured personal information and substituted before sending
- **Files you upload** to AI services — text is extracted and scanned for personal information before upload
- **Your identity configuration** — names, emails, usernames, hostnames, phones, and their substitute values, stored in browser local storage
- **Your substitution mappings** — real-to-substitute value pairs you configure
- **Activity log** — a local record of substitutions performed (never sent anywhere)
- **Settings and preferences** — extension configuration

## Where data is stored

All data is stored in your browser's `storage.local` (the extension's private storage area). When at-rest encryption is enabled, all sensitive data is AES-256-GCM encrypted before being written to storage.

Data is **never** sent to any server operated by Silent Send or any third party. The only network requests Silent Send makes are:

- **To the AI service you are already using** (e.g., claude.ai, chatgpt.com) — this is the substituted/sanitized version of your text, not the original
- **GitHub Gist sync** (optional, user-initiated) — if you configure Gist sync, your encrypted settings are stored in a private Gist on your own GitHub account
- **Custom URL sync** (optional, user-initiated) — if you configure a custom sync endpoint, encrypted settings are sent to the URL you specify
- **Org policy URL** (optional) — if you join an organization, the extension fetches the policy JSON from the URL your admin provides

## Data sharing

Silent Send does not share any data with anyone. There are no analytics providers, no crash reporting services, no advertising networks, and no data brokers involved.

## Data retention

All data persists in your browser until you delete it. You can:
- Clear all data via Options → Danger Zone → Reset Everything
- Uninstall the extension (removes all stored data)
- Export your data before clearing

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `storage` | Store your identity, mappings, settings, and activity log locally |
| `activeTab` | Access the current tab to inject the substitution script |
| `scripting` | Inject content scripts on custom domains you configure |
| `notifications` | Show desktop notifications for sync status updates |
| `alarms` | Background polling for auto-sync and org policy updates |
| Host permissions (claude.ai, etc.) | Intercept API requests to substitute personal information before sending |

## Children's privacy

Silent Send does not knowingly collect data from children under 13. The extension does not collect data from anyone — it processes everything locally.

## Changes to this policy

If this privacy policy changes, the updated version will be posted at this URL and in the extension's GitHub repository.

## Contact

For questions about this privacy policy, open an issue at: https://github.com/outis1one/silent-send/issues

## Open source

Silent Send's source code is publicly available at https://github.com/outis1one/silent-send — you can verify every claim in this policy by reading the code.
