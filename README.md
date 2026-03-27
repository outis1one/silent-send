# Silent Send

A browser extension (Chrome, Firefox, and Safari) that intercepts personal information and substitutes it with user-defined replacements before sending to AI services.

### Supported services

| Service | Domains | Status |
|---------|---------|--------|
| Claude | claude.ai, claude.ai/code | Tested |
| ChatGPT | chatgpt.com, chat.openai.com | Untested |
| Grok | grok.x.ai, x.com/i/grok | Untested |
| Gemini | gemini.google.com | Untested |
| OpenWebUI | localhost, 127.0.0.1, or custom domain | Untested |

> **Note:** Only Claude has been tested so far. The other services have API interception patterns defined but may need adjustments. PRs welcome.
>
> **Browsers:** Chrome, Firefox (signed .xpi), and Safari (via Xcode project). All three use the same core code.

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
| `JohnSmith` | `AlexDemo` |
| `johnsmith` | `alexdemo` |
| `john.smith` | `alex.demo` |
| `john_smith` | `alex_demo` |
| `smith-john` | `demo-alex` |

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

### Proper noun detection (automatic)

The auto-detect scanner also catches capitalized words mid-sentence that might be names, company names, or project names you forgot to configure. For example:

| You type | What happens |
|----------|-------------|
| `...talked to Sarah about the deploy` | Flags "Sarah" as a possible name |
| `...the Acme Corp internal API` | Flags "Acme Corp" as a possible organization |
| `...pushed to Project Atlas staging` | Flags "Project Atlas" as a possible project name |

These are flagged as warnings (not auto-redacted) so you can decide whether to add them as mappings. Common English words, programming terms, days, and months are excluded to reduce false positives.

### Bulk import (speed up setup)

Import your existing data from password managers and browser autofill to pre-populate identity and mappings:

| Source | What's imported |
|---|---|
| Chrome password CSV | Usernames, emails, domains, passwords (auto-redacted) |
| Firefox logins CSV | Usernames, emails, domains, passwords (auto-redacted) |
| Bitwarden CSV | Usernames, emails, domains, passwords (auto-redacted) |
| 1Password CSV | Usernames, emails, domains, passwords (auto-redacted) |
| Browser autofill CSV | Names, emails, phones, addresses |
| Plain CSV (2 columns) | Real → substitute pairs |
| Plain text (1 per line) | Auto-categorized values needing substitutes |

Passwords are imported as exact-match mappings (e.g. `MyS3cret!` → `[REDACTED-PASSWORD-1]`) so they get caught in any context — not just `password=value` patterns.

Go to **Options** → **Transfer Data** → **Import CSV / Password Export**.

### Document scanning

When you upload files to an AI service, Silent Send extracts and scans the text for PPI before the file is sent:

| Format | How it works |
|---|---|
| PDF | Text extracted from content streams, PPI substituted, uploaded as clean plaintext |
| DOCX, XLSX, PPTX | XML text extracted from ZIP structure, PPI substituted, uploaded as plaintext |
| ODT, ODS, ODP | OpenDocument XML text extracted, PPI substituted |
| DOC, XLS | Legacy binary format — readable text runs extracted |
| RTF | Formatting stripped, text extracted |
| TXT, CSV, JSON, code files | Direct string substitution |
| Images (PNG, JPG, etc.) | Not scanned — no text to extract |
| Scanned PDFs (image-only) | Not scanned — no text layer |

For PDF/DOCX/XLSX uploads, a preview panel shows what PPI was found before uploading. You can choose to substitute and upload, or upload the original. Text files are substituted silently. The original file on your disk is never modified — substitution only happens to the in-flight upload.

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

| Icon color | Badge | Meaning |
|-----------|-------|---------|
| **Gray** | | Not configured — does nothing until you set up your identity |
| **Black** | | Active and protecting |
| **Blue** | | Reveal mode on — showing your real data in AI responses |
| **Red** | | Manually disabled |
| Any | **LOCK** (red) | Vault locked — encrypted data, needs password to unlock |
| Any | **SYN** (purple) | New settings synced from another device |

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

1. **Test tab** — click the extension icon → Test tab. Type text containing your real data and see the substituted version live, highlighted in green. This is the quickest way to confirm your identity is configured correctly.

2. **Badge count** — after sending a message, the extension icon shows a green number (e.g. "3") indicating how many substitutions were made. If you see a number, it's working.

3. **Inspect the actual network request** — this proves your real data never reaches the AI:
   - Open browser DevTools (F12) → **Network** tab
   - Send a message containing your real data
   - Find the POST request to the AI service (e.g. `chat/completions` or `conversation`)
   - Click it → **Payload** or **Request** tab
   - Search for your real data — it should not be there. You should only see the replaced data.

4. **Activity tab** — click the extension icon → Activity tab. Shows a timestamped log of every substitution with the original and replaced values.

5. **Console log** — DevTools (F12) → Console shows `[Silent Send] Substituted N value(s) in <url>` for each intercepted request.

6. **Reveal mode** — toggle with the eye icon or `Alt+Shift+R`. When on, the AI's responses display your real data instead of the replaced values. When off, you see what the AI actually received. If toggling changes the text, substitution is working.

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

1. Open `chrome://extensions/` in Chrome (or `brave://extensions/` in Brave)
2. Enable **Developer mode** (toggle in the top right corner)
3. Click **Load unpacked**
4. Navigate to the `silent-send` folder you cloned and select it
5. Navigate to any supported AI site — the extension icon appears in your toolbar

That's it for Chrome. No build step, no account, no store, no fees.

> **Important:** After reloading the extension (e.g. after a code update), you must **refresh any open AI chat tabs** (F5 or Ctrl+R). The old content script keeps running until the page is refreshed.

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

### Safari (macOS)

Safari extensions require an Xcode project wrapper. Apple provides a converter that does this automatically.

#### Prerequisites

- macOS with [Xcode](https://apps.apple.com/app/xcode/id497799835) installed (free from Mac App Store)
- Xcode Command Line Tools: `xcode-select --install`
- For App Store distribution: [Apple Developer account](https://developer.apple.com/) ($99/year)

#### Build the Safari extension

```bash
git clone https://github.com/outis1one/silent-send.git
cd silent-send
npm install
./build-safari.sh
```

This generates an Xcode project at `safari-build/`. Open it in Xcode:

```bash
open safari-build/Silent\ Send.xcodeproj
```

#### Test without an Apple Developer account

1. Open the Xcode project
2. Select **Product → Run** (Cmd+R) — this builds and launches Safari with the extension
3. In Safari: **Settings → Extensions** → enable "Silent Send"
4. If Safari says the extension is unsigned:
   - Safari menu → **Settings → Advanced** → check "Show features for web developers"
   - Safari menu → **Develop → Allow Unsigned Extensions** (you'll need to re-enable this every time Safari restarts)

## Custom domains (OpenWebUI, etc.)

If you run OpenWebUI or another AI service on a custom domain (not localhost), go to **Options** → **Custom Domains** and add your domain (e.g. `https://ai.myserver.com`). The extension will activate on those domains too.

For Chrome, you'll need to also grant the extension permission to access the new domain via `chrome://extensions/` → Silent Send → Details → Site access.

## Architecture

```
manifest.json           — Chrome extension manifest (Manifest V3)
manifest.firefox.json   — Firefox variant (adds gecko ID for signing)
build.sh                — Copies the right manifest to dist/{chrome,firefox}/
build-safari.sh         — Converts to Safari extension via Xcode project
sign-firefox.sh         — Signs Firefox extension via Mozilla API
src/
  background/
    service-worker.js   — Badge management, auto-sync alarms, org policy polling
  content/
    injector.js         — Content script (isolated world) — loads config, bridges messaging
    content.js          — Page script (main world) — hooks fetch(), does substitution, document scanning
    content.css         — Visual indicators (highlights, reveals, document scan preview)
  popup/
    popup.html/css/js   — Quick access: identity, mappings, activity, test, options
  options/
    options.html/css/js — Full mapping management, import/export, settings, custom domains
  lib/
    substitution-engine.js — Core explicit find/replace logic
    smart-patterns.js   — Auto-detection of emails, names, usernames, hostnames, phones, paths
    secret-scanner.js   — Auto-detection of API keys, tokens, passwords, SSNs, credit cards
    crypto.js           — AES-256-GCM encryption, PBKDF2 key derivation, TOTP (RFC 6238), WebAuthn, key caching
    sync.js             — Cross-browser sync with encryption (browser sync, Gist, folder, URL, sync codes)
    storage.js          — Browser storage wrapper with transparent at-rest encryption
    auto-detect.js      — PPI pattern detection (IPs, addresses, paths, proper nouns)
    document-scanner.js — PDF/DOCX/XLSX/ODT/RTF text extraction and scanning
    import-parser.js    — Bulk import from CSV, password managers, autofill exports
    version-history.js  — Sync version snapshots + rollback
    merge.js            — Three-way field-level merge for sync conflicts
    org-policy.js       — Organization policy management (shared rules, compliance)
    tamper-guard.js     — Admin password protection for destructive actions
    browser-polyfill.js — Chrome/Firefox API compatibility
```

## Sync features

### Auto sync

When configured, the extension automatically pushes and pulls settings on a configurable interval (5/15/30/60 minutes) using GitHub Gist or a custom URL endpoint. Local changes trigger an immediate push.

### Conflict resolution

When both this device and another device change the same data between syncs, the extension performs a three-way merge:
- Non-conflicting changes are merged automatically
- True conflicts (same field changed on both sides) are presented in a side-by-side UI where you choose "Keep Local" or "Keep Remote" for each conflict

### Version history + rollback

Every sync operation saves a snapshot of your data. You can browse previous versions and restore any snapshot. Configurable max snapshots (default 10).

### Connected devices

Each device registers itself with a name and browser type. The device list is shared via sync data so you can see all connected devices, when they last synced, and remove old ones.

## Organization / Team

For teams that want to enforce privacy rules across all members:

1. **Admin** creates a JSON policy file hosted at any URL (static file, S3, cloud function)
2. **Team members** join by entering the policy URL or an invite code in Options → Organization
3. **Org rules merge** with personal rules — required mappings are always active and cannot be disabled
4. **Compliance dashboard** shows which required fields are configured (without revealing actual PPI)
5. **Policy updates** are polled automatically (hourly)

### Org policy format

```json
{
  "orgId": "acme-corp",
  "orgName": "Acme Corp",
  "version": 2,
  "requiredMappings": [
    { "real": "acme-internal.com", "substitute": "example-corp.com", "category": "domain" }
  ],
  "requiredSecretPatterns": [
    { "name": "Acme Token", "regex": "acme_[a-z0-9]{32}", "redact": "[REDACTED-ACME-TOKEN]" }
  ],
  "sharedIdentityRules": {
    "requireCatchAllEmail": true,
    "requiredCategories": ["name", "email", "domain"]
  }
}
```

### Tamper protection

Optional admin password (separate from vault password) that gates destructive actions:
- Disabling the extension
- Clearing data or mappings
- Leaving an organization
- Exporting data in plaintext

This is a deterrent for casual tampering. It cannot prevent browser-level uninstall or developer tools access.

## Privacy & Security

- All data stays local in browser storage — no external servers, no telemetry, no analytics
- The extension only activates on supported AI sites (and any custom domains you add)
- Your real identity data never leaves your machine

### At-rest encryption

When you enable **sync encryption** (Options → Sync Between Browsers → Sync Encryption), all sensitive data is AES-256-GCM encrypted before being written to browser storage:

| What's encrypted | Contains |
|---|---|
| Identity profiles | Real names, emails, usernames, hostnames, phones + substitutes |
| Mappings | All real → substitute pairs |
| Activity log | History of what was substituted |
| Settings | Custom domains, configuration preferences |
| TOTP secret | Authenticator app shared secret |
| All sync data | Everything sent to Gist, sync folders, custom URLs, browser sync |

**Only two things remain plaintext** — the encryption salt (needed to derive the key) and a verification blob (needed to check the password). Neither contains PPI.

Without at-rest encryption, data is stored in plaintext in the browser's local storage (similar to cookies and localStorage). Anyone with file system access to your browser profile directory could read it.

### Vault unlock

After a browser restart, the extension is in a **locked** state:

1. Badge shows **LOCK** in red — substitutions are paused
2. Click the extension icon to see the unlock prompt
3. Enter your password (first time per device), or use biometric/TOTP for re-verification
4. Protection resumes immediately across all open tabs

This is similar to how password managers work — your vault is locked until you authenticate.

### Authentication options

| Method | When it's used |
|---|---|
| **Password** | Required once per device to derive the encryption key. The key is then cached indefinitely in IndexedDB. |
| **TOTP** | Optional second factor alongside password. Can also be used alone for re-verification after the key is cached. |
| **WebAuthn (biometric/PIN)** | Primary re-verification method after first setup. Uses fingerprint, Face ID, or Windows Hello. |

Re-verification (biometric, TOTP, or password) is only triggered when the configurable TTL expires (default: 90 days) **and** new sync data exists. If nothing changed, you're never prompted.

### Cross-device sync encryption

All sync channels (browser sync, GitHub Gist, folder sync, custom URL, sync codes) encrypt data before sending. A new device bootstraps itself from the encrypted sync payload:

1. Pull encrypted data from any sync channel
2. Enter the same password used on the original device (once)
3. Full configuration (including TOTP secret) is restored from the encrypted payload
4. WebAuthn credential is registered locally for future re-verification

### Managed browser deployments

For organizations that want to prevent extension removal:

- **Chrome / Chromium / Edge:** Use the `ExtensionInstallForcelist` group policy. See [Chrome Enterprise policies](https://chromeenterprise.google/policies/#ExtensionInstallForcelist).
- **Firefox:** Use the `ExtensionSettings` policy in `policies.json` or via Group Policy. See [Firefox Enterprise policies](https://mozilla.github.io/policy-templates/#extensionsettings).

These are standard browser management features — Silent Send does not attempt to prevent its own removal.

### Smart reveal

Reveal mode only replaces values that were **actually substituted** in outbound messages during the current session. If the AI uses a word that happens to match one of your substitute values (e.g., the AI says "the user should..." and "user" is a configured substitute), it won't be falsely revealed as your real username.

## What Silent Send can't catch

Silent Send works well for text you type and most document uploads, but some things will get through:

- **Images and screenshots** — can't scan pixels. A screenshot of your terminal with your username in it goes through unchanged.
- **Scanned PDFs** — if the PDF is just an image with no text layer, there's nothing to substitute.
- **Base64 and encoded data** — data embedded in encoded formats isn't detected.
- **Names inside other words** — if your name is "Art", it won't catch "article" (word boundaries prevent most false positives, but edge cases exist).
- **Data you haven't configured** — it can only substitute what you told it about, plus known secret formats. Your home address or employer name won't be caught unless you add them.
- **Short names** — names under 3 characters are skipped for usernames/hostnames to avoid false positives.
- **Custom secret formats** — the secret scanner knows common API key prefixes (sk-, ghp_, AKIA, etc.) but won't catch proprietary token formats your company uses.

**Think of it like a spell checker for privacy** — it catches most things, but you should still glance at sensitive messages before sending.

## Disclaimer

Silent Send is provided "as is" without warranty of any kind. It is a convenience tool that reduces the chance of accidentally sharing personal information with AI services. It is not a security guarantee and should not be your only privacy protection. The source code is available for inspection — you don't have to take our word for it.

## License

[Business Source License 1.1](LICENSE) — free for personal, non-commercial use. Commercial use requires a paid license. The code converts to MIT on March 26, 2030.

Contributions welcome. If you find a bug, especially a privacy-related one, please [open an issue](https://github.com/outis1one/silent-send/issues).
