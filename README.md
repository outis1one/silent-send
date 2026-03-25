# Silent Send

A Chrome extension that intercepts personal information and substitutes it with user-defined replacements before sending to Claude.ai.

## How it works

1. **You define mappings** — e.g. "John Smith" → "Alex Demo", "john@gmail.com" → "alex@example.com"
2. **You type normally** — you see your real text while composing
3. **On send, it swaps** — the extension intercepts the API request and replaces real values with substitutes
4. **Badge shows count** — the extension icon shows how many substitutions were made
5. **Reveal mode** — optionally translates Claude's responses back to your real data

## How to verify it's working

- **Badge count** on the extension icon shows substitutions per page
- **Activity tab** in the popup shows a timestamped log of every substitution
- **Test tab** in the popup lets you type text and see the before/after diff
- **Reveal mode** (eye icon) toggles showing real vs substitute data in responses
- **Browser DevTools** → Console shows `[Silent Send] Substituted N value(s)` messages

## Installation (Developer Mode)

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select this directory
6. Navigate to claude.ai — the extension is active

No build step needed. No Chrome Web Store required.

## Architecture

```
manifest.json           — Extension manifest (Manifest V3)
src/
  background/
    service-worker.js   — Badge management, logging coordination
  content/
    injector.js         — Content script (isolated world) — loads config, bridges messaging
    content.js          — Page script (main world) — hooks fetch(), does substitution
    content.css         — Visual indicators (highlights, reveals)
  popup/
    popup.html/css/js   — Quick access: add mappings, view activity, test mode
  options/
    options.html/css/js — Full mapping management, import/export, settings
  lib/
    substitution-engine.js — Core find/replace logic
    storage.js          — Chrome storage wrapper
```

## Privacy

- All data stays local in Chrome storage
- No external servers, no telemetry, no analytics
- The extension only activates on claude.ai
