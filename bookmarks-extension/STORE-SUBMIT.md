# Store submission — Bookmarks Sync **1.1.3**

Prepare packages, then upload to **Google** and sign/submit for **Mozilla**.

```bash
# From repo root
npm run ext:prepare-store
```

That builds versioned packages, runs `web-ext lint`, and writes  
`dist/STORE-SUBMIT-1.1.3.txt` with paste-ready copy.

| Browser | Artifact | Action |
|---|---|---|
| **Chrome / Brave** | `dist/bookmarks-sync-chrome-1.1.3.zip` | Upload to [Chrome Web Store Dashboard](https://chrome.google.com/webstore/devconsole) |
| **Firefox** | `dist/bookmarks-sync-firefox-1.1.3.xpi` (**Mozilla-signed** in repo) | Install from file / AMO; re-sign only after source changes |

**Extension version:** `1.1.3`  
**Server** (this repo): `1.2.3` (versioned separately)

---

## Pre-flight (already covered by `ext:prepare-store`)

- [x] Chrome + Firefox manifests same version  
- [x] Manifest V3  
- [x] Chrome: `service_worker`, no gecko block, optional hosts only  
- [x] Firefox: fixed `gecko.id`, `data_collection_permissions: bookmarksInfo`, optional hosts only  
- [x] `web-ext lint` → 0 errors / 0 warnings  
- [x] ZIP/XPI have `manifest.json` at archive root  
- [x] Privacy policy files in `docs/`  
- [x] Store screenshots under `docs/chrome-store/`  

---

## Google Chrome Web Store

### 1. Upload package

1. Open [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → item **`ndiehbfpikbmhdgffcfohoeojlmfbpal`**.
2. **Package** → **Upload new package** →  
   `dist/bookmarks-sync-chrome-1.1.3.zip`
3. Keep the same item ID so user settings survive the update.

### 2. Privacy (confirm, usually unchanged)

| Field | Value |
|---|---|
| Privacy policy URL | `https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md` |
| Handles user data | **Yes** (bookmarks + settings for sync) |
| Sold | **No** |
| Used for | Functionality only — sync with **user’s** server |

### 3. Permissions justification (if asked again)

| Permission | Justification |
|---|---|
| `bookmarks` | Read/write the bookmark tree to sync with the user’s server. |
| `storage` | Store API URL, API key, sync settings, and id-map on device only. |
| `alarms` | Optional periodic sync. |
| `notifications` | Optional sync failure alerts. |
| `optional_host_permissions` `http://*/*` `https://*/*` | User’s self-hosted API can be any origin; access is **optional** and requested only for that origin on Save / Test connection. No fixed third-party analytics host. |

### 4. What's new (paste)

```text
• Multi-browser delete fix: tombstones and sticky soft-deletes so deletes propagate
• Toolbar fix: Brave “Bookmarks bar” and Firefox “Bookmarks Toolbar” map to the same toolbar root
• Safer sync apply: avoid nested root folders and unnecessary reordering on Firefox
• Same privacy model: data only goes to the API URL you configure
```

### 5. Single purpose (paste)

```text
Sync the user’s browser bookmarks with their self-hosted Bookmarks Sync server.
```

### 6. Listing assets (optional refresh)

| Asset | Path |
|---|---|
| Screenshots 1280×800 | `docs/chrome-store/screenshot-01-options-1280x800.png`, `screenshot-02-popup-1280x800.png` |
| Small promo 440×280 | `docs/chrome-store/promo-small-440x280.png` |
| Marquee 1400×560 | `docs/chrome-store/promo-marquee-1400x560.png` |

Full listing copy: [CHROME-STORE.md](./CHROME-STORE.md).

### 7. Submit for review

Dashboard → **Submit for review**. Review can take from hours to several days.

---

## Mozilla AMO / signed Firefox XPI

### 1. AMO API credentials (one-time)

1. [addons.mozilla.org](https://addons.mozilla.org/developers/) developer account  
2. [API keys](https://addons.mozilla.org/developers/addon/api/key/) → JWT  
3. Export (do **not** commit):

```bash
export WEB_EXT_API_KEY="user:YOUR_KEY_ID"
export WEB_EXT_API_SECRET="YOUR_SECRET"
```

### 2. Sign

```bash
# Unlisted (self-distribute XPI; fastest for repo dist/)
npm run ext:sign-firefox

# Or public AMO listing
npm run ext:sign-firefox -- --listed
```

Produces signed:

```text
dist/bookmarks-sync-firefox-1.1.3.xpi
dist/bookmarks-sync-firefox.xpi
```

Verify:

```bash
unzip -l dist/bookmarks-sync-firefox-1.1.3.xpi | grep META-INF/mozilla.rsa
```

### 3. Notes for Mozilla reviewers (paste)

```text
Purpose
  Sync browser bookmarks with a self-hosted Bookmarks Sync server that the user
  (or their admin) configures. Open source: https://github.com/offsyanka99/bookmarks-sync

Data
  Bookmarks (titles, URLs, folders, order) and extension settings (API URL, API key,
  sync preferences) stay between this browser and the user’s server.
  The extension developer does not operate a default cloud or analytics backend.

Host access
  optional_host_permissions for http://*/* and https://*/* exist because users may
  self-host on any hostname/port. Access is NOT granted at install for all sites.
  The extension calls permissions.request only for the origin of the API base URL
  the user enters, when they click Save or Test connection.

Data collection (AMO)
  required: bookmarksInfo — necessary to read/write bookmarks for sync.

Permissions
  bookmarks, storage, alarms, notifications, optional_host_permissions.

Privacy policy
  https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md

Test credentials
  Reviewers need any Bookmarks Sync server + API key. The project README describes
  Docker/local setup. Extension Options: API base URL (API port) + API key → Save
  (allow host) → Test connection → Sync now.
```

### 4. AMO listing fields (if listed)

| Field | Value |
|---|---|
| Name | Bookmarks Sync |
| Summary | Sync bookmarks with your own self-hosted server. You control the data. |
| Categories | Bookmarks, Privacy & Security (or Productivity) |
| Support / Homepage | `https://github.com/offsyanka99/bookmarks-sync` |
| Privacy policy | `https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md` |
| License | MIT (match repo) |

### 5. Version notes (paste)

```text
1.1.3
- Multi-browser delete: tombstones + sticky soft-deletes
- Toolbar root mapping: Chromium “Bookmarks bar” ↔ Firefox “Bookmarks Toolbar”
- Avoid nested root-named folders; reduce toolbar reordering noise on Firefox
- Optional host access only (AMO-friendly)
```

---

## Smoke test before submit

### Chrome

1. `chrome://extensions` → Load unpacked → `bookmarks-extension/chrome/` (or the ZIP)  
2. Options → API URL + key → **Save** → allow host  
3. Test connection → Sync now  
4. Confirm popup shows **v1.1.3**

### Firefox

1. Prefer signed XPI after `ext:sign-firefox`, or temporary load of `firefox/`  
2. Options → Save (must allow host — no install-time all-hosts access)  
3. Test connection → Sync now  
4. Toolbar should not invent nested “Bookmarks bar/Toolbar” folders  

---

## After approval

1. Commit signed `dist/bookmarks-sync-firefox-1.1.3.xpi` if you distribute from the repo.  
2. Tag release notes for **1.1.3** if desired.  
3. Users: Chrome updates from the store; Firefox install-from-file with the same gecko id keeps settings.
