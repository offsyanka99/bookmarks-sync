# Bookmarks Sync — Browser Extensions

**Extension package version:** `1.1.0` (Chrome Web Store / XPI). Server is versioned separately (`package.json`).

Manifest **V3** extensions for **Chrome**, **Brave**, and **Firefox**. Each browser has its **own folder** with a correct `manifest.json` (Chromium and Firefox disagree on `background`).

| Browser | Folder to load | Background |
|---|---|---|
| **Chrome / Brave** | [`chrome/`](./chrome/) | `service_worker` |
| **Firefox 128+** | [`firefox/`](./firefox/) | `scripts` |

**Source of truth for code:** `chrome/`. After editing, sync into Firefox:

```bash
# From repo root
npm run ext:sync
```

---

## Features

| Area | Details |
|---|---|
| **Connection** | API base URL + API key; test via `/health`, `/info`, list bookmarks |
| **Manual sync** | Toolbar popup → **Sync now** |
| **Change-based sync** | Debounced (~2.5s) after local create / edit / move / delete |
| **Sync on startup** | Runs a few seconds after the browser profile starts |
| **Time-based sync** | Alarms; default interval **15** minutes |
| **Strategies** | Merge (recommended), download (server wins), upload (local wins) |
| **Match by URL** | When applying server data, reuse a same-folder local URL if the id map misses (avoids duplicates; on by default) |
| **ID map** | Browser bookmark id ↔ server UUID in extension storage |
| **Host access** | Optional permission only for the API origin you configure |

---

## Prerequisites (server)

1. Run the bookmarks-sync **server** (`npm start` or Docker).  
2. Open the **admin** UI; create a **user**.  
3. **Copy** that user’s API key.  
4. Note the **API** base URL (**not** the admin port):

| Setup | Example |
|---|---|
| Defaults | `http://127.0.0.1:31059` |
| Custom `SERVER_PORT=31039` | `http://127.0.0.1:31039` |
| Reverse proxy | `https://bookmarks.example.com` |

---

## Install

### Chrome / Brave — Chrome Web Store (recommended)

Install from the published listing:

**[Bookmarks Sync — Chrome Web Store](https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal)**

1. Click **Add to Chrome** (or equivalent in Brave / other Chromium browsers).  
2. Options → API base URL + API key → **Save** → allow host access.  
3. **Test connection** → **Sync now**.

Store item ID: `ndiehbfpikbmhdgffcfohoeojlmfbpal` (keep this stable across updates).

### Chrome / Brave — developer (unpacked)

1. Open `chrome://extensions` or `brave://extensions`.  
2. Enable **Developer mode**.  
3. **Load unpacked** → select:

   ```text
   bookmarks-sync/bookmarks-extension/chrome
   ```

4. Options → API base URL + API key → **Save** → allow host access.  
5. **Test connection** → **Sync now**.

Packaging / re-publish for the store: **[CHROME-STORE.md](./CHROME-STORE.md)**

### Firefox — permanent (keeps settings after close)

Temporary add-ons are **deleted when Firefox quits**. For a real install on **release Firefox**, use a **Mozilla-signed** `.xpi` (same extension id):

```text
dist/bookmarks-sync-firefox-1.1.0.xpi
```

`about:addons` → gear → **Install Add-on From File…** → choose that file.  
Repo rebuilds are often **unsigned** until re-signed for AMO / self-distribution — see **[FIREFOX-INSTALL.md](./FIREFOX-INSTALL.md)**.

### Firefox — temporary (dev only)

1. `npm run ext:sync`  
2. `about:debugging` → **Load Temporary Add-on** → `bookmarks-extension/firefox/manifest.json`  

**Do not** load `chrome/` into Firefox (`service_worker` error).  
Temporary installs do **not** survive restart.

---

## Layout

```text
bookmarks-extension/
├── README.md
├── FIREFOX-INSTALL.md       # Permanent .xpi install
├── shared/
│   └── icons/               # single source of truth for PNG icons
├── scripts/
│   ├── sync-firefox.mjs     # npm run ext:sync (chrome → firefox + icons)
│   ├── check-extension-sync.mjs  # npm run ext:check
│   └── pack.mjs             # npm run ext:pack-firefox
├── chrome/                  # ← load in Chrome / Brave
│   ├── manifest.json        # service_worker
│   ├── background.js
│   ├── lib/                 # folderCodec, treeCollect, treeApply, …
│   ├── popup/
│   ├── options/
│   └── icons/               # filled from shared/icons on ext:sync
└── firefox/                 # ← load in Firefox
    ├── manifest.json        # scripts (no service_worker)
    ├── background.js        # synced from chrome/
    ├── lib/
    ├── popup/
    ├── options/
    └── icons/
```

| Task | Command / path |
|---|---|
| Edit code | Change files under **`chrome/`** |
| Update Firefox copy | `npm run ext:sync` |
| Guard chrome ↔ firefox | `npm run ext:check` |
| Install Chrome (users) | [Chrome Web Store](https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal) |
| Pack Chrome store ZIP | `npm run ext:pack-chrome` → `dist/bookmarks-sync-chrome-*.zip` — see [CHROME-STORE.md](./CHROME-STORE.md) |
| Pack unsigned Firefox `.xpi` | `npm run ext:pack-firefox` → `dist/bookmarks-sync-firefox.xpi` |
| Install Firefox (release) | **`dist/bookmarks-sync-firefox-1.1.0.xpi`** (Mozilla-signed) — see FIREFOX-INSTALL.md |
| Load Chromium (dev) | Unpacked → **`chrome/`** |
| Load Firefox (dev) | Temporary add-on → **`firefox/`** |

---

## Configure (Options)

### Server

- **API base URL** — API port only  
- **API key** — `bms_…` from admin UI  

### Sync behaviour

| Option | Description |
|---|---|
| Change-based synchronization | Sync after local bookmark changes |
| Sync on startup | Sync when the browser starts |
| Time-based synchronization | Periodic sync |
| Synchronization interval | Minutes (default **15**), if time-based is on |

### Synchronization strategy

| Strategy | Behaviour |
|---|---|
| **Merge** *(recommended)* | Push + merge by timestamps; apply server set |
| **Download** | Server wins — rewrite this browser from the server |
| **Upload** | This browser wins — force local tree onto the server |

### Advanced

- Where **new** server bookmarks are created (Other Bookmarks / Bookmarks Bar)  
- Remove local bookmarks deleted on the server  
- **Match local bookmarks by URL** (recommended) — avoid creating a second local entry when the id map is incomplete  

**Test connection** shows its multi-line result **directly under the button** (not at the bottom of the long form).

---

## Popup

| Control | Action |
|---|---|
| **Sync now** | Full sync with saved strategy |
| **Test connection** | Health + info + auth |
| **Settings** | Options page |

---

## API used

```http
Authorization: Bearer <api-key>
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/info` | Status |
| `GET` | `/api/bookmarks` | List / download strategy |
| `POST` | `/api/bookmarks/sync` | Merge / upload |

See [root README — API](../README.md#api-multi-user).

---

## Permissions

| Permission | Why |
|---|---|
| `bookmarks` | Read/write bookmark tree |
| `storage` | Settings, ID map, meta |
| `alarms` | Time-based sync |
| `notifications` | Background error toasts |
| Optional host access | Your API origin only |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **`service_worker is currently disabled`** | Load **`firefox/`**, not `chrome/` |
| Host / network error | Re-save Options and allow the API origin |
| **`permissions.request may only be called from a user input handler`** (Firefox) | Use **Save** or **Test connection** (a real click). Reload the `firefox/` add-on after updating. |
| **`NetworkError when attempting to fetch resource`** (Firefox only; Brave works) | Usually host access. **Remove and re-load** `firefox/` (manifest now includes `host_permissions`). Prefer `http://127.0.0.1:PORT`. Turn off **HTTPS-Only Mode** for that URL, or add an exception. Confirm API port (e.g. 31039), not admin. |
| `401` | Fresh API key; user must be active |
| Wrong port | Use **API** port (`SERVER_PORT`), not admin |
| Firefox gone after restart | Temporary add-on — load `firefox/` again |
| Firefox missing latest code | Run `npm run ext:sync`, then reload add-on |
| Unexpected overwrites | Check strategy (Merge vs Download vs Upload) |

### Logs

- **Chromium:** extension details → Service worker → Inspect  
- **Firefox:** `about:debugging` → Inspect  

---

## Development

1. Edit under **`chrome/`**.  
2. `npm run ext:sync` to refresh **`firefox/`**.  
3. Reload the extension in the browser.  

No bundler required.
