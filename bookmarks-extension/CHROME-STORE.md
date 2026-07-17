# Chrome Web Store — package & publish

**Published listing (users install from here):**

**[https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal](https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal)**

| | |
|---|---|
| **Store item ID** | `ndiehbfpikbmhdgffcfohoeojlmfbpal` |
| **Status** | Live (Google-signed) |
| **Current package version** | **1.1.1** |

Chrome does **not** use a local “sign this XPI” flow like Firefox.  
You upload a **ZIP** to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole); Google hosts and signs the published item.

This document is for **maintainers** updating the live listing. End users should install from the store URL above (see [README.md](./README.md)).

---

## Submit update 1.1.1 (checklist)

### Package ready to upload

| Item | Path |
|---|---|
| **ZIP (upload this)** | [`dist/bookmarks-sync-chrome-1.1.1.zip`](../dist/bookmarks-sync-chrome-1.1.1.zip) |
| Stable name (same bytes) | `dist/bookmarks-sync-chrome.zip` |
| Manifest version | `1.1.1` |
| Privacy policy URL | `https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md` |

Rebuild anytime:

```bash
# From repo root
npm run ext:pack-chrome
```

### Store graphics (upload in Dashboard → Store listing)

Pre-generated at required sizes under [`docs/chrome-store/`](../docs/chrome-store/):

| Asset | File | Size |
|---|---|---|
| Screenshot 1 (options) | `docs/chrome-store/screenshot-01-options-1280x800.png` | 1280×800 |
| Screenshot 2 (popup) | `docs/chrome-store/screenshot-02-popup-1280x800.png` | 1280×800 |
| Small promo tile | `docs/chrome-store/promo-small-440x280.png` | 440×280 |
| Marquee (optional) | `docs/chrome-store/promo-marquee-1400x560.png` | 1400×560 |
| Listing icon | from package `icons/icon128.png` | 128×128 |

640×400 variants of the screenshots are also in that folder if you prefer.

### Dashboard steps (update)

1. Open [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → item **`ndiehbfpikbmhdgffcfohoeojlmfbpal`**.
2. **Package** → **Upload new package** → select `dist/bookmarks-sync-chrome-1.1.1.zip`.
3. **Store listing** → upload/replace screenshots + promo tiles if desired (optional for this release).
4. **Privacy** → confirm practices still match §4 (no change required for 1.1.1).
5. **What's new** (this version) — paste:

```text
• Last sync timestamps follow the server TIME_FORMAT setting (24h or 12h AM/PM)
• Reads clock style from GET /info (works with Bookmarks Sync server 1.2.2+)
• Same privacy model: data only goes to the API URL you configure
```

6. Review permissions justifications (unchanged — see table below).
7. **Submit for review**.

Keep the same store item ID so user settings survive the update.

### Local smoke test before submit

1. `chrome://extensions` → Developer mode → **Load unpacked** → `bookmarks-extension/chrome/`  
   (or load the built ZIP).
2. Options → API URL + key → **Save** → allow host access.
3. **Test connection** — should list `Time format: 24h` or `12h` when server is 1.2.2+.
4. Open popup → **Last sync** uses that clock style (no forced mismatch with server env).
5. **Sync now** against your server API port.

Do **not** load the Firefox folder into Chrome.

---

## 1. Build the store package

From the **repo root**:

```bash
npm run ext:pack-chrome
```

Creates:

```text
dist/bookmarks-sync-chrome-1.1.1.zip   # versioned (upload this)
dist/bookmarks-sync-chrome.zip         # same contents, stable name
```

The ZIP root **is** the extension root (`manifest.json` at the top of the archive — not nested in a folder).

### Package checklist (automated by the pack script)

| Check | Status |
|---|---|
| Manifest V3 | yes |
| `background.service_worker` | yes |
| No Firefox `browser_specific_settings` | yes |
| Icons 16 / 32 / 48 / 128 | yes |
| Description ≤ 132 characters | yes |
| No `key.pem` in package | enforced |

---

## 2. Developer Dashboard steps

**First publish** (already done for this project — kept for reference):

1. Pay the one-time Chrome Web Store developer registration fee (if not already done).
2. Open [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item**.
3. Upload the versioned ZIP from `dist/`.
4. Fill the store listing (see copy below).
5. **Privacy** practices (required):
   - Declare that the extension handles **user data** (bookmarks, and network data to the user’s server).
   - Privacy policy URL (host the policy page — see §4).
6. **Permissions justification** (be explicit; reviewers read this):

| Permission | Justification |
|---|---|
| `bookmarks` | Read/write the browser bookmark tree so it can sync with the user’s server. |
| `storage` | Save API URL, API key, sync settings, and id-map in extension storage only. |
| `alarms` | Optional time-based sync interval. |
| `notifications` | Optional failure/status notifications. |
| `optional_host_permissions` `http://*/*` `https://*/*` | User enters **their own** API base URL (any host/port). Access is **optional** and requested only for that origin when they Save / Test connection. No fixed third-party analytics host. |

7. Submit for review.

**Updates** (normal path now): open the existing item `ndiehbfpikbmhdgffcfohoeojlmfbpal` → **Package** → upload new ZIP → submit.

---

## 3. Listing copy (paste into Chrome Web Store)

**Name:** Bookmarks Sync  

**Category:** Productivity  

**Language:** English  

### Short description (max 132 characters)

Use this for the store “Summary” field (also matches the extension manifest description style):

```text
Sync bookmarks with your own self-hosted server. You control the data—no third-party cloud.
```

(96 characters)

**Alternate short description** (matches `manifest.json` description):

```text
Sync browser bookmarks with your self-hosted server. Folders, merge strategies, your API key.
```

(93 characters)

### Detailed description

```text
Bookmarks Sync keeps your browser bookmarks in sync with a server you run yourself.

Unlike commercial cloud sync, nothing is stored on a vendor’s platform by default. You (or your admin) host the open-source Bookmarks Sync server; this extension connects Chrome, Brave, and other Chromium browsers to that API with a personal API key.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT IT DOES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Sync now — one click from the toolbar popup
• Change-based sync — optional auto-sync after you add, edit, move, or delete bookmarks
• Sync on startup — refresh when the browser opens
• Time-based sync — periodic background sync on an interval you choose
• Strategies:
    – Merge (recommended) — combine local and server changes safely
    – Download — make this browser match the server
    – Upload — push this browser as the source of truth
• Folders and mixed order — toolbar / other bookmarks structure and sibling order are preserved
• Match by URL — when applying server data, reuse a local bookmark with the same URL in the same folder if the id map is incomplete (reduces duplicates)
• Failsafe — large destructive syncs are refused unless you confirm in the extension UI
• Multi-device — same library on several Chromium browsers via one self-hosted backend

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY & DATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Bookmarks and credentials go only to the API base URL you configure
• API key and settings stay in this browser’s extension storage
• No ads, no tracking SDK, no developer-operated bookmark cloud
• Open source: https://github.com/offsyanka99/bookmarks-sync

You must operate (or be given access to) a Bookmarks Sync server. This extension does not include hosting.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Install and run the Bookmarks Sync server (see the GitHub project).
2. Open the admin UI, create a user, and copy that user’s API key.
3. Open this extension’s Options.
4. Paste the API base URL (API port, not the admin port) and the API key.
5. Click Save and allow host access when the browser prompts.
6. Test connection, then Sync now from the popup.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERMISSIONS (WHY WE ASK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Bookmarks — read and update the local tree during sync
• Storage — save server URL, API key, and sync preferences on this device
• Alarms — optional scheduled sync
• Notifications — optional alerts if a background sync fails
• Optional host access — only for the server origin you enter (any self-hosted URL)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Docs, issues, and source code:
https://github.com/offsyanka99/bookmarks-sync

Self-hosted only. If something fails, check the server is reachable, the API key is valid, and host permission was granted for your API origin.
```

### Single-purpose description (dashboard field)

Chrome asks for a short “single purpose” statement:

```text
Sync the user’s browser bookmarks with their self-hosted Bookmarks Sync server.
```

---

## 4. Privacy policy URL

Chrome Web Store requires a **public HTTPS** privacy policy because the extension handles user data (bookmarks + settings).

### Option A — GitHub (recommended, free)

Policy files in this repo:

| File | Use |
|---|---|
| [`docs/PRIVACY.md`](../docs/PRIVACY.md) | Simple markdown |
| [`docs/privacy.html`](../docs/privacy.html) | Standalone HTML page |

**URLs you can paste into the store** (after the files are on `main`):

```text
https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md
```

or (cleaner page if you enable GitHub Pages for `/docs`):

```text
https://offsyanka99.github.io/bookmarks-sync/privacy.html
```

GitHub blob URLs are commonly accepted. Prefer **GitHub Pages** if a reviewer complains that the policy must be a normal webpage.

**Enable GitHub Pages (optional):** repo **Settings → Pages → Deploy from branch `main` → folder `/docs`**.

### Option B — Your own server

This repo also serves:

```text
/privacy-extension.html
```

Example: `https://your-domain.example/privacy-extension.html`

**What to declare in the dashboard (typical):**

- **Collects user data:** Yes (for extension functionality).
- User data is **not** sold.
- Used only to sync with the **user’s configured server**.
- Bookmarks and API credentials stay between the browser and that server.
- The developer does **not** operate a default bookmark cloud.

---

## 5. Store assets

| Asset | Size | Location |
|---|---|---|
| Screenshots | 1280×800 (or 640×400) | [`docs/chrome-store/`](../docs/chrome-store/) |
| Small promo tile | 440×280 | same folder |
| Marquee | 1400×560 | same folder (optional) |
| Icons | 16–128 | in the ZIP (`icons/`) |

Icons already in the package (`icons/icon128.png`, etc.) are used for the store listing icon.

---

## 6. After publish / updates

Live listing:  
https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal

1. Bump `bookmarks-extension/chrome/manifest.json` → `version`.
2. `npm run ext:pack-chrome`
3. Dashboard → item **`ndiehbfpikbmhdgffcfohoeojlmfbpal`** → **Package** → upload new ZIP → submit.

Keep the same Chrome Web Store item ID so user settings survive updates.

---

## 7. Local test before upload

1. `chrome://extensions` → Developer mode → **Load unpacked** → `bookmarks-extension/chrome/`
2. Or drag the built ZIP onto `chrome://extensions` (Chrome may unpack it for testing).
3. Confirm Options, Test connection, Sync now against your server (`SERVER_PORT`).

Do **not** load the Firefox folder into Chrome.
