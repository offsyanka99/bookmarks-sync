# Firefox — permanent install (keeps settings)

## Why temporary add-ons disappear

**Load Temporary Add-on** (`about:debugging`) only lasts until Firefox quits.  
That is by design. Settings vanish because the temporary add-on is removed.

For a **permanent** install that **survives restarts** and **keeps Options** (API URL, key, sync settings), you need an **installable `.xpi` file** with a **fixed extension id** (this project uses `bookmarks-sync@offsyanka99.github.io`).

---

## Recommended: Mozilla-signed XPI from this repo

A **signed** release package is under `dist/`:

```text
dist/bookmarks-sync-firefox-1.1.1.xpi   # current (Mozilla-signed, AMO-approved)
dist/bookmarks-sync-firefox-1.1.0.xpi   # previous signed release
dist/bookmarks-sync-firefox.xpi         # stable name = latest signed (1.1.1)
```

AMO may also name downloads like `befd3a8e446247cfa279-1.1.1.xpi` — same signed bytes; prefer the names above in the repo.

Works on **normal release Firefox** only when the file is **Mozilla-signed** (contains `META-INF/mozilla.rsa`).  
Unsigned rebuilds only work on Developer Edition / Nightly (Option A) or after you sign (below).

### Install (signed XPI)

1. Download the `.xpi` from the repo (`dist/` on GitHub, or your clone).
2. Open Firefox → `about:addons`.
3. Gear icon ⚙ → **Install Add-on From File…**
4. Choose `dist/bookmarks-sync-firefox-1.1.1.xpi` (or the latest signed version).
5. Confirm permissions → **Options** → API base URL + API key → **Save**.
6. **Test connection** → **Sync now** from the toolbar popup.

Extension id (must stay the same for updates):  
`bookmarks-sync@offsyanka99.github.io`

---

## Sign release 1.1.1 (maintainer checklist)

Source and lint are ready. Signing requires **your** AMO credentials (not stored in the repo).

### 1. Prerequisites

| Check | Status |
|---|---|
| Manifest version | `1.1.1` |
| Gecko id | `bookmarks-sync@offsyanka99.github.io` |
| `data_collection_permissions` | `bookmarksInfo` (AMO requirement) |
| `strict_min_version` | `128.0` |
| `web-ext lint` | `npm run ext:lint-firefox` → 0 errors |
| Unsigned pack | `npm run ext:pack-firefox` → `dist/bookmarks-sync-firefox-1.1.1.xpi` |

### 2. AMO API credentials (one-time)

1. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/).
2. Open [API keys](https://addons.mozilla.org/developers/addon/api/key/).
3. Generate a JWT and export in your shell:

```bash
export WEB_EXT_API_KEY="user:YOUR_KEY_ID"
export WEB_EXT_API_SECRET="YOUR_SECRET"
```

Do **not** commit these values.

### 3. Sign (unlisted — self-distribute XPI)

From the **repo root**:

```bash
npm run ext:sign-firefox
```

This will:

1. Sync `chrome/` → `firefox/`
2. Upload to AMO and wait for Mozilla signature (`web-ext sign --channel=unlisted`)
3. Write:

```text
dist/bookmarks-sync-firefox-1.1.1.xpi
dist/bookmarks-sync-firefox.xpi
```

Confirm the file is signed:

```bash
unzip -l dist/bookmarks-sync-firefox-1.1.1.xpi | grep META-INF/mozilla.rsa
```

### 4. Optional — public AMO listing

```bash
npm run ext:sign-firefox -- --listed
```

Then finish listing text / review in the [AMO developer hub](https://addons.mozilla.org/developers/).

### 5. After signing

1. Install from file on **release** Firefox and smoke-test Options → Test connection → Sync.
2. Commit the **signed** XPIs under `dist/` (and this doc if version notes changed).
3. Users update via **Install Add-on From File** with the same gecko id (settings kept).

### What’s new in 1.1.1

- Last sync timestamps follow server `TIME_FORMAT` (`24h` / `12h`) via `GET /info`
- Works with Bookmarks Sync server **1.2.2+**

---

## Build an unsigned `.xpi` yourself (dev)

From the **repo root**:

```bash
npm run ext:pack-firefox
# → dist/bookmarks-sync-firefox-1.1.1.xpi  (unsigned)
# → dist/bookmarks-sync-firefox.xpi        (same, unsigned)
```

```bash
npm run ext:lint-firefox   # AMO-oriented validation
```

Unsigned packages only install on **Firefox Developer Edition / Nightly** with signatures disabled (Option A below), or after you sign them.

---

## Other install paths

Mozilla **release** Firefox only allows **signed** extensions (or enterprise policy).

### Option A — Developer Edition / Nightly (unsigned XPI)

Best for private testing without signing.

1. Install [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/) (or Nightly).
2. Open `about:config` → accept the risk.
3. Set:

   | Preference | Value |
   |---|---|
   | `xpinstall.signatures.required` | **`false`** |

4. `about:addons` → gear → **Install Add-on From File…**
5. Choose your unsigned `dist/bookmarks-sync-firefox.xpi`.

> Release Firefox usually **ignores** `xpinstall.signatures.required = false`. Prefer a **signed** XPI for normal Firefox.

### Option B — Sign (same as checklist above)

```bash
export WEB_EXT_API_KEY="user:..."
export WEB_EXT_API_SECRET="..."
npm run ext:sign-firefox
```

### Option C — Enterprise policy (managed machines)

Use Firefox `policies.json` / Group Policy to force-install the XPI from a file or HTTPS URL. See [Mozilla Policy Templates](https://mozilla.github.io/policy-templates/).

---

## After install

1. Pin **Bookmarks Sync** to the toolbar if you want.
2. **Options** → API base URL (e.g. `http://127.0.0.1:31039`) + API key → **Save**.
3. **Test connection** → **Sync now**.

Settings are stored under the fixed id  
`bookmarks-sync@offsyanka99.github.io` — they survive restarts and extension updates **as long as you install updates with the same id** (install the new XPI over the old one; do not remove the add-on first unless you want a wipe).

---

## Update the extension later

1. Get the new signed `.xpi` from `dist/` (or rebuild + re-sign).
2. **about:addons → Install Add-on From File** again.

Firefox updates the add-on and **keeps** settings when the gecko id is unchanged.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Could not be verified for use in Firefox” | Release Firefox blocks **unsigned** XPIs → use a **signed** file (`META-INF/mozilla.rsa`), or Option A (Dev Edition). |
| Extension gone after restart | You used **temporary** load — use the `.xpi` install above. |
| Settings wiped after update | Extension id changed, or you removed the add-on before reinstalling. |
| Network / host permission errors | Options → **Save** or **Test connection** and allow access to the API origin. |
| `web-ext sign` auth error | Regenerate JWT at AMO API keys; re-export `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`. |

---

## Dev tips

- Edit code under `bookmarks-extension/chrome/`.
- Sync code chrome → firefox: `npm run ext:sync`
- Temporary load for debugging only: `about:debugging` → `bookmarks-extension/firefox/manifest.json`
- Lint: `npm run ext:lint-firefox`
- Sign: `npm run ext:sign-firefox` (needs AMO credentials)
