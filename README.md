# Silent Send

A browser extension (Chrome + Firefox) that intercepts personal information and substitutes it with user-defined replacements before sending to AI services.

### Supported services

| Service | Domains | Status |
|---------|---------|--------|
| Claude | claude.ai, claude.ai/code | Tested |
| ChatGPT | chatgpt.com, chat.openai.com | Untested |
| Grok | grok.x.ai, x.com/i/grok | Untested |
| Gemini | gemini.google.com | Untested |
| OpenWebUI | localhost, 127.0.0.1 (self-hosted) | Untested |

> **Note:** Only Claude has been tested so far. The other services have API interception patterns defined but may need adjustments. PRs welcome.

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

### Prerequisites

You need [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/) (v18+) installed.

Clone the repo:
```bash
git clone https://github.com/outis1one/silent-send.git
cd silent-send
```

### Chrome (Developer Mode)

1. Run `./build.sh chrome` (or just use the root directory directly)
2. Open `chrome://extensions/` in your browser
3. Enable **Developer mode** (toggle in the top right corner)
4. Click **Load unpacked** → navigate to and select the `dist/chrome/` folder (or the repo root)
5. Navigate to any supported AI site — the extension icon appears in your toolbar

That's it for Chrome. No account, no store, no fees.

### Firefox (signed, persistent)

Firefox requires extensions to be cryptographically signed before it will install them permanently. Mozilla provides free self-hosted signing — no store listing, no review process, no fees.

#### Step 1: Create a free Firefox account

1. Go to https://accounts.firefox.com/ and create an account (or sign in if you have one)
2. This is the same account used for Firefox Sync — you may already have one

#### Step 2: Get your Mozilla API credentials

1. Go to https://addons.mozilla.org/developers/addon/api/key/
2. Sign in with your Firefox account from step 1
3. On that page you'll see two values:
   - **JWT issuer** — this is your API key, looks like `user:12345678:901`
   - **JWT secret** — a long alphanumeric string, this is your API secret
4. Keep this page open — you'll need both values in the next step

#### Step 3: Configure your credentials

```bash
# Install dependencies
npm install

# Copy the env template
cp .env.example .env
```

Now open `.env` in any text editor and paste in your values from step 2:
```
WEB_EXT_API_KEY="user:12345678:901"
WEB_EXT_API_SECRET="your-jwt-secret-here"
```

Save the file.

#### Step 4: Build and sign

```bash
source .env && npm run sign:firefox
```

This builds the Firefox version and submits it to Mozilla for signing. It takes 10-30 seconds. When done, you'll see a signed `.xpi` file in `dist/firefox-signed/`.

#### Step 5: Install the signed extension

- Drag the `.xpi` file into any Firefox window, **or**
- Firefox menu → File → Open File → select the `.xpi`
- Click **Add** when prompted

The signed `.xpi` is **permanent** — it survives browser restarts, updates, everything. No store listing, no review process, no fees. You only need to re-sign when you update to a new version.

### Firefox (temporary, for development)

If you just want to try it out without signing:
```bash
npm install && npm run run:firefox
```
This opens a fresh Firefox with the extension pre-loaded. Auto-reloads on file changes. Resets when Firefox closes — useful for testing, not for daily use.

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
