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

## Installation

### Chrome (Developer Mode)
1. Clone this repo
2. Run `./build.sh chrome` (or just use the root directory directly)
3. Open `chrome://extensions/`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** → select `dist/chrome/` (or root dir)
6. Navigate to claude.ai — the extension is active

### Firefox (signed, persistent)
1. Clone this repo
2. `npm install`
3. Get your free Mozilla API credentials at https://addons.mozilla.org/developers/addon/api/key/
4. `cp .env.example .env` and fill in your key + secret
5. `source .env && npm run sign:firefox`
6. Install the `.xpi` file from `dist/firefox-signed/` — drag it into Firefox or use File → Open
7. Navigate to claude.ai — the extension is active

The signed `.xpi` is permanent — survives restarts, no store listing needed.

### Firefox (temporary, for development)
```
npm install && npm run run:firefox
```
Opens Firefox with the extension pre-loaded. Reloads on file changes.

No store required for either browser.

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
    storage.js          — Browser storage wrapper
    browser-polyfill.js — Chrome/Firefox API compatibility
```

## Privacy

- All data stays local in browser storage
- No external servers, no telemetry, no analytics
- The extension only activates on claude.ai
