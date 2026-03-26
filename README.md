# Silent Send

A browser extension (Chrome + Firefox) that intercepts personal information and substitutes it with user-defined replacements before sending to AI services.

### Supported services

| Service | Domains | Status |
|---------|---------|--------|
| Claude | claude.ai, claude.ai/code | Tested |
| ChatGPT | chatgpt.com, chat.openai.com | Untested |
| Grok | grok.x.ai, x.com/i/grok | Untested |
| Gemini | gemini.google.com | Untested |
| OpenWebUI | localhost, 127.0.0.1, or custom domain | Untested |

> **Note:** Only Claude has been tested so far. The other services have API interception patterns defined but may need adjustments. PRs welcome.

## How it works

1. **You fill in your Identity** — name, email, username, computer name, phone
2. **Smart patterns auto-catch variations** — `jsmith@macbook-pro`, `John's`, `/home/jsmith`, `555.123.4567`
3. **Secret scanner auto-redacts credentials** — API keys, tokens, passwords, SSNs, credit cards (zero config)
4. **You type normally** — you see your real text while composing
5. **On send, it swaps** — the extension intercepts the API request and replaces real values with substitutes
6. **Badge shows count** — the extension icon shows how many substitutions were made
7. **Reveal mode** — translates AI responses back to your real data, right in the chat window

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

### Secret scanner (automatic, no configuration needed)

| You type | What gets sent |
|----------|---------------|
| `sk-proj-abc123xyz789...` | `[REDACTED-OPENAI-KEY]` |
| `sk-ant-api01-xyz...` | `[REDACTED-ANTHROPIC-KEY]` |
| `ghp_xxxxxxxxxxxxxxxxxxxx` | `[REDACTED-GITHUB-TOKEN]` |
| `AKIAIOSFODNN7EXAMPLE` | `[REDACTED-AWS-KEY]` |
| `sk_live_abc123...` | `[REDACTED-STRIPE-KEY]` |
| `AIzaSyxxxxxxxxxxxxxxxxx` | `[REDACTED-GOOGLE-KEY]` |
| `glpat-xxxxxxxxxxxx` | `[REDACTED-GITLAB-TOKEN]` |
| `xoxb-xxx-xxx-xxx` | `[REDACTED-SLACK-TOKEN]` |
| `Bearer eyJhbGciOi...` | `Bearer [REDACTED]` |
| `password=MyS3cret!` | `password=[REDACTED]` |
| `api_key=abcdef123456...` | `api_key=[REDACTED]` |
| `postgres://user:pass@host` | `postgres://REDACTED:REDACTED@host` |
| `-----BEGIN RSA PRIVATE KEY-----` | `[REDACTED-PRIVATE-KEY]` |
| `123-45-6789` | `[REDACTED-SSN]` |
| `4111 1111 1111 1111` | `[REDACTED-CARD]` |

## First-time setup

After installing the extension, **it does nothing until you configure it**. The icon will be gray to remind you.

1. Click the Silent Send icon in your toolbar
2. You'll see the **Identity** tab with a red "Setup required" banner
3. Fill in your real info and fake substitutes:
   - **Names** — add as many as needed (first, last, nicknames). Click "+ Add" for more rows.
   - **Emails** — your real email → fake email. Set a catch-all for unknown addresses.
   - **Usernames** — your system username → fake username
   - **Hostnames** — your computer name → fake computer name
   - **Phones** — your phone number → fake number
4. Click **Save Identity**
5. The icon turns **black** — you're now protected

You can create multiple profiles (Personal, Work, Spouse) using the dropdown at the top. Each can be toggled on/off independently.

### Icon colors

| Icon color | Meaning |
|-----------|---------|
| **Gray** | Not configured — does nothing until you set up your identity |
| **Black** | Active and protecting |
| **Blue** | Reveal mode on — showing your real data in AI responses |
| **Red** | Manually disabled |

### Reveal mode

When reveal mode is on (eye icon or `Alt+Shift+R`), the AI's responses are displayed with your **real data** instead of the fake substitutes. This is purely a local display change — **the AI never received your real data**. It only ever saw the fake names, emails, paths, etc.

This exists so you can easily copy paths, commands, and code from the AI's response and paste them directly into your terminal or editor without manually translating fake values back to real ones.

For example:
- AI responds: `Edit the file at /home/ademo/project/config.yaml`
- With reveal mode ON, you see: `Edit the file at /home/jsmith/project/config.yaml`
- Copy that path, paste into terminal — it works

Toggle it off and the display reverts to the fake data the AI actually received.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Toggle reveal mode |
| `Alt+Shift+S` | Toggle Silent Send on/off |

Remap in Chrome: `chrome://extensions/shortcuts` | Firefox: `about:addons` → gear → Manage Extension Shortcuts

## How to verify it's working

- **Badge count** on the extension icon shows substitutions per page
- **Activity tab** in the popup shows a timestamped log of every substitution
- **Test tab** in the popup lets you type text and see the before/after diff live
- **Reveal mode** (eye icon or `Alt+Shift+R`) shows your real data in AI responses for easy copy/paste
- **Browser DevTools** → Console shows `[Silent Send] Substituted N value(s)` messages

## Installation

### Prerequisites

- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org/) v18 or newer (needed for Firefox signing only)

### Step 1: Get the code

Open a terminal (Terminal on Mac, Command Prompt or PowerShell on Windows, any terminal on Linux) and run:

```bash
git clone https://github.com/outis1one/silent-send.git
cd silent-send
```

This downloads the extension code to a `silent-send` folder on your computer.

### Chrome

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in the top right corner)
3. Click **Load unpacked**
4. Navigate to the `silent-send` folder you cloned and select it
5. Navigate to any supported AI site — the extension icon appears in your toolbar

That's it for Chrome. No build step, no account, no store, no fees.

### Firefox (signed, persistent)

Firefox requires extensions to be cryptographically signed before it will permanently install them. Mozilla provides free signing — no store listing, no review process, no fees. You just need a free Firefox account.

#### Step 1: Create a free Firefox account

1. Go to https://accounts.firefox.com/ and sign up (or sign in if you have one already)
2. This is the same account used for Firefox Sync — you may already have one

#### Step 2: Generate your signing keys

1. Go to https://addons.mozilla.org/developers/addon/api/key/
2. Sign in with your Firefox account
3. You'll see two values on that page:
   - **JWT issuer** — looks like `user:12345678:901`
   - **JWT secret** — a long string of random characters
4. You need both of these. Copy them or keep the page open.

#### Step 3: Install dependencies and save your signing keys

In your terminal, inside the `silent-send` folder:

**Mac / Linux:**
```bash
npm install
cp .env.example .env
```

**Windows (Command Prompt):**
```cmd
npm install
copy .env.example .env
```

Now open the `.env` file in any text editor (Notepad, VS Code, etc.) and replace the placeholder values with the two values from step 2:

```
WEB_EXT_API_KEY="user:12345678:901"
WEB_EXT_API_SECRET="your-jwt-secret-here"
```

Save and close the file.

#### Step 4: Build and sign

**All platforms (Mac, Linux, Windows with Git Bash):**
```bash
npm run sign:firefox
```

The sign script reads your `.env` file automatically — no need to `source` it. First-time signing can take **1-5 minutes** while Mozilla validates and approves the extension. Subsequent signs are usually faster. When done, you'll find a signed `.xpi` file in `dist/firefox-signed/`.

**Windows (Command Prompt — if not using Git Bash):**
```cmd
node -e "require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,v]=l.split('=');if(k&&v)process.env[k.trim()]=v.trim().replace(/^\"|\"$/g,'')})" && npm run sign:firefox
```

**Windows (PowerShell):**
```powershell
Get-Content .env | ForEach-Object { if ($_ -match '^(.+?)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim('"')) } }
npm run sign:firefox
```


#### Step 5: Install

- Drag the `.xpi` file into any Firefox window, **or**
- Firefox menu → File → Open File → select the `.xpi`
- Click **Add** when prompted

Done. The extension is **permanently installed** — survives restarts, updates, everything. You only need to re-sign if you update to a newer version of Silent Send.

### Firefox (temporary, no signing needed)

If you just want to try it out quickly:

**Mac / Linux:**
```bash
npm install && npm run run:firefox
```

**Windows:**
```cmd
npm install && npm run run:firefox
```

This opens Firefox with the extension pre-loaded. Resets when Firefox closes — useful for testing.

## Custom domains (OpenWebUI, etc.)

If you run OpenWebUI or another AI service on a custom domain (not localhost), go to **Options** → **Custom Domains** and add your domain (e.g. `https://ai.myserver.com`). The extension will activate on those domains too.

For Chrome, you'll need to also grant the extension permission to access the new domain via `chrome://extensions/` → Silent Send → Details → Site access.

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
    options.html/css/js — Full mapping management, import/export, settings, custom domains
  lib/
    substitution-engine.js — Core explicit find/replace logic
    smart-patterns.js   — Auto-detection of emails, names, usernames, hostnames, phones, paths
    secret-scanner.js   — Auto-detection of API keys, tokens, passwords, SSNs, credit cards
    storage.js          — Browser storage wrapper
    browser-polyfill.js — Chrome/Firefox API compatibility
```

## Privacy

- All data stays local in browser storage
- No external servers, no telemetry, no analytics
- The extension only activates on supported AI sites (and any custom domains you add)
- Your real identity data never leaves your machine

## License

[MIT](LICENSE) — use it for anything, commercial or personal, modify it, redistribute it, relicense it. Just keep the copyright notice in copies of the code.
