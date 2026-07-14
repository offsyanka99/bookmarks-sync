# Firefox — permanent install (keeps settings)

## Why temporary add-ons disappear

**Load Temporary Add-on** (`about:debugging`) only lasts until Firefox quits.  
That is by design. Settings vanish because the temporary add-on is removed.

For a **permanent** install that **survives restarts** and **keeps Options** (API URL, key, sync settings), you need an **installable `.xpi` file** with a **fixed extension id** (this project uses `bookmarks-sync@offsyanka99.github.io`).

---

## 1. Build the `.xpi`

From the **repo root**:

```bash
npm run ext:pack-firefox
```

Creates:

```text
dist/bookmarks-sync-firefox.xpi
```

(Also: `npm run ext:pack` builds Chrome zip + Firefox xpi.)

---

## 2. Install permanently

Mozilla **release** Firefox only allows **signed** extensions (or enterprise policy).  
Pick one path:

### Option A — Firefox Developer Edition / Nightly (unsigned XPI, self-hosted)

Best for private / self-hosted use without an AMO account.

1. Install [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/) (or Nightly).
2. Open `about:config` → accept the risk.
3. Set:

   | Preference | Value |
   |---|---|
   | `xpinstall.signatures.required` | **`false`** |

4. Open `about:addons` → gear icon ⚙ → **Install Add-on From File…**
5. Choose `dist/bookmarks-sync-firefox.xpi`.
6. Confirm permissions → open **Options** → enter API URL + key → **Save**.

After this, closing Firefox **keeps** the extension and your settings.

> Standard “Firefox” release often **ignores** `xpinstall.signatures.required = false`. Use Developer Edition/Nightly for unsigned XPIs.

### Option B — Mozilla-signed XPI (works on normal Firefox)

Requires a free [addons.mozilla.org](https://addons.mozilla.org) developer account and API credentials.

```bash
npm run ext:sync
cd bookmarks-extension/firefox

# One-time: create JWT from https://addons.mozilla.org/developers/addon/api/key/
export WEB_EXT_API_KEY="user:..."
export WEB_EXT_API_SECRET="..."

npx web-ext sign --channel=unlisted --source-dir . --artifacts-dir ../../dist
```

Install the signed `.xpi` from `dist/` via **about:addons → Install Add-on From File**.  
Unlisted signed add-ons work on **release** Firefox without the public AMO listing.

### Option C — Enterprise policy (managed machines)

Use Firefox `policies.json` / Group Policy to force-install the XPI from a file or HTTPS URL. See [Mozilla Policy Templates](https://mozilla.github.io/policy-templates/).

---

## 3. After install

1. Pin **Bookmarks Sync** to the toolbar if you want.
2. **Options** → API base URL (e.g. `http://127.0.0.1:31039`) + API key → **Save**.
3. **Test connection** → **Sync now**.

Settings are stored in the browser under the fixed id  
`bookmarks-sync@offsyanka99.github.io` — they survive restarts and extension updates **as long as you install updates with the same id** (rebuild/reinstall the new XPI; do not remove the add-on first unless you want a wipe).

---

## Update the extension later

```bash
npm run ext:pack-firefox
```

Then **about:addons → Install Add-on From File** again (same XPI name is fine).  
Firefox updates the add-on and **keeps** settings when the gecko id is unchanged.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| “Could not be verified for use in Firefox” | Release Firefox blocks unsigned XPIs → use Option A (Dev Edition) or Option B (sign). |
| Extension gone after restart | You used **temporary** load — use the `.xpi` + Option A or B. |
| Settings empty after reinstall | You removed the add-on (storage wiped) or id changed — keep id stable; prefer “install over” update. |
| NetworkError on Test connection | Allow host access; prefer `http://127.0.0.1:PORT`; check HTTPS-Only Mode. |

---

## Related

- Source folders: `bookmarks-extension/chrome/`, `bookmarks-extension/firefox/`
- Sync code chrome → firefox: `npm run ext:sync`
- Full extension docs: [README.md](./README.md)
