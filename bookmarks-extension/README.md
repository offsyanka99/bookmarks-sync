# Bookmarks Sync — Browser Extension

**Version:** `0.2.0` (matches server package version)

Manifest **V3** extension for **Chrome** and **Brave**. Syncs this browser’s bookmarks with your self-hosted [bookmarks-sync](../README.md) server using a per-user API key.

## Features

- Configure **API base URL** + **API key**
- **Test connection** (health, info, auth)
- **Sync now** from the toolbar popup
- **Sync behaviour**: change-based, on startup, time-based (interval, default 15 min)
- **Strategies**: merge (recommended), download (server wins), upload (this browser wins)
- Stable ID mapping between Chrome bookmark IDs and server UUIDs (stored in `chrome.storage.local`)
- Host permission requested only for the origin you configure

## Install (unpacked)

1. Start the bookmarks-sync **server** and create a user in the admin UI. Copy that user’s **API key**.
2. Open the browser extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
3. Enable **Developer mode**.
4. **Load unpacked** → select this folder:

   ```text
   bookmarks-sync/bookmarks-extension
   ```

5. Open the extension **Options** (or popup → Settings).
6. Set:
   - **API base URL** — e.g. `http://127.0.0.1:31059` (API port, **not** admin port)
   - **API key** — `bms_…` from the admin portal
7. Allow host access when the browser prompts.
8. **Test connection**, then **Sync now**.

## Usage

| UI | Action |
|---|---|
| Popup → **Sync now** | Run sync using the selected strategy |
| Popup → **Test connection** | `/health`, `/info`, and (if key set) list bookmarks |
| Options | Server, sync behaviour, strategy, advanced |

### Sync behaviour (Options)

| Option | Effect |
|---|---|
| **Change-based synchronization** | Debounced sync (~2.5s) after local bookmark create/edit/move/delete |
| **Sync on startup** | Sync a few seconds after browser profile start |
| **Time-based synchronization** | Chrome alarm every N minutes (interval field, default **15**) |

### Synchronization strategy

| Strategy | Behaviour |
|---|---|
| **Merge** (recommended) | Push local + merge by `updatedAt` / `lastSyncAt`, then apply server set |
| **Download** | Do not upload; rewrite this browser from the server list |
| **Upload** | Force this browser’s tree onto the server (`force` + `replace`) |

Grant host permission once in Settings so background sync (alarms / change / startup) can call your server without a prompt.

## Permissions

| Permission | Why |
|---|---|
| `bookmarks` | Read/write the browser bookmark tree |
| `storage` | Settings, ID map, last sync meta |
| `alarms` | Periodic auto-sync |
| `notifications` | Optional error toast on background sync failure |
| Optional host access | `fetch` to your self-hosted API origin only |

## Project layout

```text
bookmarks-extension/
├── manifest.json
├── background.js          # service worker (alarms + messages)
├── lib/
│   ├── api.js             # REST client + host permission
│   ├── storage.js         # chrome.storage helpers
│   ├── bookmarks.js       # tree collect / apply
│   └── sync.js            # end-to-end sync
├── popup/                 # toolbar UI
├── options/               # settings page
├── icons/
└── README.md
```

## Limits & next steps

- No end-to-end encryption (same model as the server).
- First sync on a second browser will create bookmarks under the configured root for any IDs that browser has not seen yet.
- Folder renames/moves are path-based, not Chrome folder-id based.
- Future ideas: per-folder filters, conflict UI, Firefox build, stricter URL schemes.

## Development

No build step — edit files and click **Reload** on `chrome://extensions`.

Service worker logs: extension details → **Service worker** / Inspect views.
