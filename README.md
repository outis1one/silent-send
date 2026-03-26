# Silent Send

A browser extension (Chrome + Firefox) that intercepts personal information and substitutes it with user-defined replacements before sending to AI services.

### Supported services

| Service | Domains |
|---------|---------|
| Claude | claude.ai, claude.ai/code |
| ChatGPT | chatgpt.com, chat.openai.com |
| Grok | grok.x.ai, x.com/i/grok |
| Gemini | gemini.google.com |
| OpenWebUI | localhost, 127.0.0.1 (self-hosted) |

## How it works

1. **You fill in your Identity** — name, email, username, computer name, phone
2. **Smart patterns auto-catch variations** — `jsmith@macbook-pro`, `John's`, `/home/jsmith`, `555.123.4567`
3. **You type normally** — you see your real text while composing
4. **On send, it swaps** — the extension intercepts the API request and replaces real values with substitutes
5. **Badge shows count** — the extension icon shows how many substitutions were made
6. **Reveal mode** — optionally translates Claude's responses back to your real data

### Smart pattern examples

| You type | What gets sent |
|----------|---------------|
| `jsmith@macbook-pro` | `ademo@mycomputer` |
| `anyone@gmail.com` | `anon@example.com` (catch-all) |
| `John Smith` | `Alex Demo` |
| `Smith, John` | `Demo, Alex` |
| `John's code` | `Alex's code` |
| `/home/jsmith/project` | `/home/ademo/project` |
| `~jsmith` | `~ademo` |
| `C:\Users\jsmith` | `C:\Users\ademo` |
| `(555) 123-4567` | `(555) 000-0000` |
| `555.123.4567` | `(555) 000-0000` |
| `macbook-pro` | `mycomputer` |

## How to verify it's working

- **Badge count** on the extension icon shows substitutions per page
- **Activity tab** in the popup shows a timestamped log of every substitution
- **Test tab** in the popup lets you type text and see the before/after diff live
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

Firefox requires extensions to be signed. Mozilla provides free self-hosted signing — no store listing needed.

#### Step 1: Get your Mozilla API credentials

1. Go to https://addons.mozilla.org/developers/addon/api/key/
2. Sign in with a Firefox account (create one free if you don't have one)
3. On that page you'll see two values:
   - **JWT issuer** — looks like `user:12345678:901`
   - **JWT secret** — a long alphanumeric string
4. These are your API key and secret

#### Step 2: Configure and sign

```bash
# Install dependencies
npm install

# Copy the env template and fill in your credentials
cp .env.example .env
```

Edit `.env` with the values from step 1:
```
WEB_EXT_API_KEY="user:12345678:901"
WEB_EXT_API_SECRET="your-jwt-secret-here"
```

Then build and sign:
```bash
source .env && npm run sign:firefox
```

This produces a signed `.xpi` file in `dist/firefox-signed/`.

#### Step 3: Install the signed extension

- Drag the `.xpi` file into any Firefox window, **or**
- Firefox menu → File → Open File → select the `.xpi`
- Click "Add" when prompted

The signed `.xpi` is **permanent** — it survives browser restarts, updates, everything. No store listing, no review process, no fees.

### Firefox (temporary, for development)
```bash
npm install && npm run run:firefox
```
Opens Firefox with the extension pre-loaded. Auto-reloads on file changes. Resets when Firefox closes.

## Architecture

```
manifest.json           — Chrome extension manifest (Manifest V3)
manifest.firefox.json   — Firefox variant (adds gecko ID for signing)
build.sh                — Copies the right manifest to dist/{chrome,firefox}/
src/
  background/
    service-worker.js   — Badge management, logging coordination
  content/
    injector.js         — Content script (isolated world) — loads config, bridges messaging
    content.js          — Page script (main world) — hooks fetch(), does substitution
    content.css         — Visual indicators (highlights, reveals)
  popup/
    popup.html/css/js   — Quick access: identity, mappings, activity, test mode
  options/
    options.html/css/js — Full mapping management, import/export, settings
  lib/
    substitution-engine.js — Core explicit find/replace logic
    smart-patterns.js   — Auto-detection of emails, names, usernames, hostnames, phones, paths
    storage.js          — Browser storage wrapper
    browser-polyfill.js — Chrome/Firefox API compatibility
```

## Privacy

- All data stays local in browser storage
- No external servers, no telemetry, no analytics
- The extension only activates on claude.ai
- Your real identity data never leaves your machine
