# Bookmarks Sync

**Version:** `1.2.2`

Self-hosted multi-user bookmark sync: **Node.js + Express + SQLite** API, admin portal, and browser extensions (**Chrome / Brave / Firefox**). Each user has an isolated library and a personal **API key** — no shared global key, no mandatory E2E encryption.

| Role | Auth | Access |
|---|---|---|
| **Admin** | Username + password (web UI) | Users, API keys, export, logs, dedupe, factory reset |
| **User** | API key (extension / REST) | Own bookmarks only |

**Ports** (one process): **API** `SERVER_PORT` (default `31059`) · **Admin** `ADMIN_PORT` (default `31060`)

Full reference (API details, conflict rules, env catalog): **[README.md](./README.md)**

---

## Screenshots

| Admin | Extension |
|---|---|
| ![Admin](docs/screenshots/admin-users.jpg) | ![Options](docs/screenshots/extension-options.png) ![Popup](docs/screenshots/extension-popup.png) |

---

## Quick start (local)

```bash
cp .env.example .env
npm install
npm start
# dev: npm run dev
```

| Service | Default URL |
|---|---|
| Admin (first run → `/setup`) | http://127.0.0.1:31060/ |
| API health | http://127.0.0.1:31059/health |

1. Open admin UI → set password for **`admin`** → copy API key.  
2. Create users as needed; copy each user’s API key.  
3. Point the extension at the **API** URL (not the admin port) + API key → **Save** → **Sync now**.

Optional headless bootstrap: set `ADMIN_PASSWORD` (and optional `ADMIN_USERNAME`) before first start.

---

## Docker / TrueNAS

```bash
docker compose up -d --build
```

No secrets required in compose. Data volume holds SQLite + auto `SESSION_SECRET`.

**TrueNAS SCALE:** [`docs/truenas-scale.compose.yaml`](./docs/truenas-scale.compose.yaml)

1. Dataset e.g. `tank/apps/bookmarks-sync` → `chown -R 568:568` that path.  
2. Install YAML (map host path under `volumes:`).  
3. Admin: `http://NAS-IP:31040` → `/setup` · API: `http://NAS-IP:31039`

---

## Extension

| Browser | Install |
|---|---|
| **Chrome / Brave** | [Chrome Web Store](https://chromewebstore.google.com/detail/bookmarks-sync/ndiehbfpikbmhdgffcfohoeojlmfbpal) or load unpacked `bookmarks-extension/chrome/` |
| **Firefox** | Signed XPI: [`dist/bookmarks-sync-firefox-1.1.0.xpi`](./dist/bookmarks-sync-firefox-1.1.0.xpi) → `about:addons` → Install from file |

- Talks to the **API** port only.  
- Strategies: **Merge** (default), **Download**, **Upload**.  
- Optional: change-based / startup / interval sync; match-by-URL; destructive failsafe.  

Details: [`bookmarks-extension/README.md`](./bookmarks-extension/README.md) · Firefox: [`FIREFOX-INSTALL.md`](./bookmarks-extension/FIREFOX-INSTALL.md) · Chrome store: [`CHROME-STORE.md`](./bookmarks-extension/CHROME-STORE.md)

---

## API (essentials)

```http
Authorization: Bearer bms_<api-key>
```

| | |
|---|---|
| Public | `GET /health`, `GET /info` |
| Bookmarks | `GET/POST /api/bookmarks`, `GET/PUT/DELETE /api/bookmarks/:id` |
| Sync | `POST /api/bookmarks/sync` |
| Duplicates | `GET /api/bookmarks/duplicates`, `POST /api/bookmarks/dedupe` |
| Import/export | `GET /api/bookmarks/export`, `POST /api/bookmarks/import` |

**Conflicts:** optimistic lock on `updatedAt`. Sync merges by newest timestamp; same **folder + URL** can merge into one row (`merges` in the response).  
**Duplicates:** same folder + normalized URL only (same URL in different folders is fine).

```bash
export BASE=http://127.0.0.1:31059
export USER_API_KEY='bms_...'

curl -s "$BASE/api/bookmarks" -H "Authorization: Bearer $USER_API_KEY"
curl -s -X POST "$BASE/api/bookmarks/sync" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bookmarks":[...],"replace":false,"lastSyncAt":"..."}'
```

---

## Config (common)

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_PORT` / `ADMIN_PORT` | `31059` / `31060` | API / admin listen ports |
| `DB_PATH` | `./data/bookmarks.db` | SQLite file |
| `SESSION_SECRET` | auto file | Signs admin session cookie |
| `SESSION_MAX_AGE_MINUTES` | `15` | Admin idle timeout (rolling cookie) |
| `TIME_FORMAT` | `24h` | UI clock: `24h` or `12h` (admin + extensions via `/info`) |
| `COOKIE_SECURE` | `false` | `true` only behind HTTPS |
| `ALLOW_NEW_SYNCS` | `true` | Reject sync when `false` |
| `LOG_LEVEL` / `LOG_TO_STDOUT` | `info` / `true` | Logging (stdout for Dozzle) |

Full list: [`.env.example`](./.env.example) · [README — Environment](./README.md#environment-variables)

**Forgot admin password:** Danger zone → **Reset to default**, or once: `RESET_ADMIN_PASSWORD=true` + `ADMIN_PASSWORD` → restart → remove the flag.

---

## What’s new (1.2.2)

- **`TIME_FORMAT`** (`24h` / `12h`) for admin + extension timestamps; published on `GET /info`  
- Admin portal: Session info card removed (env timeout unchanged)

---

## License

MIT
