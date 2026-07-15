# Firefox — permanent install (keeps settings)

## Why temporary add-ons disappear

**Load Temporary Add-on** (`about:debugging`) only lasts until Firefox quits.  
That is by design. Settings vanish because the temporary add-on is removed.

For a **permanent** install that **survives restarts** and **keeps Options** (API URL, key, sync settings), you need an **installable `.xpi` file** with a **fixed extension id** (this project uses `bookmarks-sync@offsyanka99.github.io`).

---

## Recommended: Mozilla-signed XPI from this repo

A **signed** release package is committed under `dist/`:

```text
dist/bookmarks-sync-firefox-1.0.0.xpi
```

Works on **normal release Firefox** when the file is **Mozilla-signed** (no Developer Edition, no `about:config` hacks).  
If only an unsigned rebuild is present, use Developer Edition or re-sign (see below).

### Install

1. Download the `.xpi` from the repo (`dist/` on GitHub, or your clone).
2. Open Firefox → `about:addons`.
3. Gear icon ⚙ → **Install Add-on From File…**
4. Choose `dist/bookmarks-sync-firefox-1.0.0.xpi`.
5. Confirm permissions → **Options** → API base URL + API key → **Save**.
6. **Test connection** → **Sync now** from the toolbar popup.

Extension id (must stay the same for updates):  
`bookmarks-sync@offsyanka99.github.io`

---

## Build an unsigned `.xpi` yourself (dev)

From the **repo root**:

```bash
npm run ext:pack-firefox
# → dist/bookmarks-sync-firefox.xpi  (unsigned rebuild)
```

Unsigned packages only install on **Firefox Developer Edition / Nightly** with signatures disabled (Option A below), or after you sign them (Option B).

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

> Release Firefox usually **ignores** `xpinstall.signatures.required = false`. Prefer the signed XPI in `dist/` for normal Firefox.

### Option B — Sign a new build yourself (AMO)

Requires a free [addons.mozilla.org](https://addons.mozilla.org) developer account and API credentials.

```bash
npm run ext:sync
cd bookmarks-extension/firefox

# One-time: JWT from https://addons.mozilla.org/developers/addon/api/key/
export WEB_EXT_API_KEY="user:..."
export WEB_EXT_API_SECRET="..."

npx web-ext sign --channel=unlisted --source-dir . --artifacts-dir ../../dist
```

Copy the signed artifact into `dist/` (e.g. `bookmarks-sync-firefox-X.Y.Z.xpi`), update docs, commit, and push so others can install from the repo.

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
| “Could not be verified for use in Firefox” | Release Firefox blocks **unsigned** XPIs → use the **signed** file in `dist/`, or Option A (Dev Edition). |
| Extension gone after restart | You used **temporary** load — use the `.xpi` install above. |
| Settings wiped after update | Extension id changed, or you removed the add-on before reinstalling. |
| Network / host permission errors | Options → **Save** or **Test connection** and allow access to the API origin. |

---

## Dev tips

- Edit code under `bookmarks-extension/chrome/`.
- Sync code chrome → firefox: `npm run ext:sync`
- Temporary load for debugging only: `about:debugging` → `bookmarks-extension/firefox/manifest.json`
