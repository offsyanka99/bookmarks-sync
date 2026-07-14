# Bookmarks Sync

**Version:** `0.9.2`

Self-hosted multi-user bookmark sync API for browsers and scripts, plus a companion **Manifest V3** extension for **Chrome**, **Brave**, and **Firefox**. Admins manage users in a web portal; each user gets an API key and isolated bookmarks in SQLite. Designed to sit behind Caddy (or similar) for HTTPS—not a full xBrowserSync clone (no mandatory E2E encryption).

**Stack:** Node.js + Express + SQLite · **Auth:** admin session (UI) + per-user API keys (REST / extension) · **Conflicts:** optimistic locking via `updatedAt` on writes; sync merges by newest timestamp.

**Multi-user model** (inspired by [Baikal](https://github.com/sabre-io/Baikal)-style admin accounts and [xBrowserSync](https://github.com/offsyanka99/xbrowsersync)-style sync):

| Who | How they authenticate | What they get |
|---|---|---|
| **Admin** | Username + password (web UI) | Create/manage users, view/copy API keys |
| **Users** | Per-user **API key** (REST API / browser extension) | Only their own bookmarks |

There is **no shared global API key**. Each user has a unique key; all bookmark operations are filtered by `user_id`.

### What’s new in 0.9.2

- **Firefox AMO:** `data_collection_permissions` (`bookmarksInfo`), `strict_min_version` **128.0**, no `innerHTML` in popup status pill, Chrome-only reorder hook without static Firefox API name
- **0.9.1:** same-`updatedAt` sync also applies **tags** / **favicon** changes
- **0.9.x extension:** Chrome / Brave / Firefox layout, folders + order, failsafe UI, shared icons, `ext:sync` / `ext:check`
- **Admin:** export ZIP, clear bookmarks, URL-only counts

---

## Architecture

Two HTTP ports run from one process (`server.js`):

| Port | Env | Purpose |
|---|---|---|
| **API** | `SERVER_PORT` (default `31059`) | REST API for bookmark sync |
| **Admin** | `ADMIN_PORT` (default `31060`) | Admin web portal only |

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│ Chrome / Brave   │   │ Firefox          │   │ Admin UI (ADMIN_PORT)    │
│ MV3 extension    │   │ MV3 extension    │   │ session · users · keys   │
└────────┬─────────┘   └────────┬─────────┘   └────────────┬─────────────┘
         │  Bearer API key      │                          │
         └──────────┬───────────┘                          │
                    ▼                                      │
         ┌──────────────────────────┐                      │
         │ Bookmark Sync API        │◄─────────────────────┘
         │ SERVER_PORT              │
         │ /health  /info           │
         │ /api/bookmarks/*         │
         └────────────┬─────────────┘
                      ▼
               SQLite (data/bookmarks.db)
               users + bookmarks (user_id)
```

Extension package: [`bookmarks-extension/`](./bookmarks-extension/) — see [Browser extension](#browser-extension-chrome--brave--firefox) below.

---

## Project structure

```
bookmarks-sync/
├── package.json
├── server.js                 # Starts API + admin servers
├── .env / .env.example
├── Dockerfile
├── docker-compose.yml
├── public/                   # Admin CSS, favicons, brand icons
├── assets/                   # Source brand / extension icon masters
├── data/
│   └── bookmarks.db          # Created on first start
├── src/
│   ├── routes/
│   ├── controllers/
│   ├── models/
│   ├── middleware/           # Session (admin) + API key (API)
│   ├── views/
│   └── utils/
├── bookmarks-extension/
│   ├── chrome/                    # Load unpacked in Chrome / Brave
│   ├── firefox/                   # Load temporary add-on in Firefox
│   ├── shared/icons/              # Icon source of truth
│   ├── scripts/sync-firefox.mjs   # npm run ext:sync (chrome → firefox)
│   ├── scripts/check-extension-sync.mjs  # npm run ext:check
│   └── README.md
├── dist/
│   └── bookmarks-sync-firefox-*.xpi  # Mozilla-signed Firefox package (tracked)
└── README.md
```

---

## Features

- **Multi-user**: admin creates accounts; no public signup
- **Admin portal** on a **separate port** from the API
- **Username + password** for admin web login
- **Per-user API keys** for `/api/bookmarks` (extension / scripts), with **copy** in the admin UI
- Bookmarks **scoped by user** (`user_id`)
- SQLite (WAL mode), soft deletes, import/export, full sync
- Bootstrap admin from `.env`; optional password reset via env flag
- **Production safeguards:** strong `SESSION_SECRET` / `ADMIN_PASSWORD` required; login & API-key rate limits
- **Browser extension (Chrome / Brave / Firefox)** — see [`bookmarks-extension/`](./bookmarks-extension/)

**Not yet**

- End-user web UI for managing bookmarks in the browser
- Signed Firefox AMO release (temporary / self-install works today)
- CSRF tokens on admin forms / hashed API keys (planned hardening)

---

## Quick start (local)

```bash
cp .env.example .env
# Local dev may keep ADMIN_PASSWORD=admin; set a strong SESSION_SECRET if you like

npm install
npm start
```

Then open:

| Service | URL (defaults) |
|---|---|
| Admin portal | http://127.0.0.1:31060/login |
| API health | http://127.0.0.1:31059/health |

**Default admin login (first bootstrap, development only):**

| Field | Default |
|---|---|
| Username | `admin` |
| Password | `admin` |

**Production** (`NODE_ENV=production`, including Docker Compose) **refuses to start** with a default/placeholder `SESSION_SECRET` or a weak `ADMIN_PASSWORD` when creating/resetting the admin. See [Session secret](#session-secret-session_secret) and [Production secrets](#production-secrets).

Dev mode (auto-restart on file changes, Node 20+):

```bash
npm run dev
```

### First-time admin

On the **first** start (when no admin exists in the database), the server creates an admin from:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
```

If `ADMIN_PASSWORD` is omitted, it defaults to `admin` in development only (with a console warning). In production, bootstrap/reset **exits** if the password is missing, a known default (`admin`, etc.), or shorter than 8 characters.

The admin **API key** is printed once in the server log and is always visible in the admin UI.

> Changing `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` later does **not** update an existing admin. See [Reset admin password](#reset-admin-password).

### Create users

1. Log in to the admin portal (admin only in v1).
2. Create a user (username, password, optional display name).
3. **Copy** that user’s **API key** (copy icon next to the key).
4. Use the key with:
   - the **browser extension** (Options → API key), or  
   - any HTTP client against the **API port** (not the admin port).

See [Browser extension](#browser-extension-chrome--brave--firefox) for install steps.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `31059` | Bookmark sync **API** port |
| `ADMIN_PORT` | `31060` | **Admin UI** port (must differ from API) |
| `SERVER_HOST` | `0.0.0.0` | Bind address for both ports |
| `ADMIN_USERNAME` | `admin` | Admin username on first bootstrap (or reset) |
| `ADMIN_PASSWORD` | `admin` (dev only) | Admin password on first bootstrap (or reset); **strong required in production** |
| `RESET_ADMIN_PASSWORD` | unset / `false` | Set to `true` once to re-apply admin login from `.env` |
| `SESSION_SECRET` | dev placeholder (dev only) | Signs admin session cookies; **strong required in production** |
| `COOKIE_SECURE` | `false` | Set `true` when admin UI is served over HTTPS |
| `CORS_ORIGINS` | empty | API CORS: empty = off; `*` = any origin; or comma-separated allowlist |
| `TRUST_PROXY` | `false` | Set when behind a reverse proxy so `req.ip` / rate limits are correct |
| `LOGIN_RATE_MAX` | `20` | Max admin login attempts per IP per window |
| `LOGIN_RATE_WINDOW_MS` | `900000` | Login rate-limit window (15 minutes) |
| `API_KEY_RATE_MAX` | `60` | Max **failed** API-key attempts per IP per window |
| `API_KEY_RATE_WINDOW_MS` | `900000` | API-key failure rate-limit window (15 minutes) |
| `DB_PATH` | `./data/bookmarks.db` | SQLite database path |
| `ALLOW_NEW_SYNCS` | `true` | Set `false` to reject sync pushes |
| `MAX_SYNC_SIZE_BYTES` | `1048576` | Max request body size (1 MiB) |
| `STATUS_MESSAGE` | — | Public message on `GET /info` |
| `LOG_LEVEL` | `info` | Initial log level (`error`…`silly`); overridable in Admin UI |
| `LOG_DIR` | `./data/logs` | Rotating log file directory |
| `LOG_TO_STDOUT` | `true` | Write logs to stdout (**required for Dozzle**) |
| `LOG_TO_FILE` | `true` | Write rotating files under `LOG_DIR` |
| `LOG_STDOUT_FORMAT` | see note | `json` (prod/Dozzle) or `pretty` (local) |
| `LOG_MAX_FILES` | `14d` | File retention (winston-daily-rotate-file) |
| `LOG_MAX_SIZE` | `20m` | Max size per log file before rotate |

`RESET_ADMIN_PASSWORD=false` (or omitted / commented out) is safe and does nothing. Only the value `true` triggers a reset.

### Production secrets

When `NODE_ENV=production` (Docker Compose sets this):

| Check | Behavior |
|---|---|
| `SESSION_SECRET` missing, &lt;16 chars, or a known placeholder | **Process exits** before listen |
| First admin bootstrap / `RESET_ADMIN_PASSWORD=true` with weak `ADMIN_PASSWORD` | **Process exits** |
| Docker Compose | `ADMIN_PASSWORD` and `SESSION_SECRET` are **required** (no weak defaults) |

Generate `SESSION_SECRET` with `openssl rand -hex 32` (or the Node one-liner under [How to generate a strong secret](#how-to-generate-a-strong-secret)), then:

```bash
export ADMIN_PASSWORD='your-strong-password'
export SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```

---

## Logging & Dozzle (TrueNAS)

Logs use **Winston** with:

| Destination | Purpose |
|---|---|
| **stdout** | Docker / TrueNAS container logs → **[Dozzle](https://dozzle.dev/)** |
| **Rotating files** | `data/logs/app-YYYY-MM-DD.log`, `error-*.log`, `exceptions-*.log`, `rejections-*.log` |

### Levels

`error` &lt; `warn` &lt; `info` &lt; `http` &lt; `verbose` &lt; `debug` &lt; `silly`

Change at runtime in the **Admin UI → Logging** section (persisted in the DB). Initial value comes from `LOG_LEVEL`.

### What is logged

- Server start / shutdown  
- Admin login success/failure, user create/delete, API key regenerate  
- HTTP access (Morgan → `http` level)  
- Bookmark sync/import summaries  
- API/admin errors, uncaught exceptions, unhandled rejections  

### Dozzle on TrueNAS Scale

Dozzle tails **container stdout/stderr**, not files inside the volume.

1. Keep **`LOG_TO_STDOUT=true`** (default).  
2. In production, logs are **JSON lines** on stdout (`LOG_STDOUT_FORMAT=json` or `NODE_ENV=production`).  
3. Deploy bookmarks-sync as a Docker/TrueNAS app so it appears in Dozzle’s container list.  
4. Open Dozzle and select the **bookmarks-sync** container — live logs appear there.  
5. Optional: keep `LOG_TO_FILE=true` for on-disk archives under the data volume (`/app/data/logs` in Docker).

Local dev uses prettier console lines unless you set `LOG_STDOUT_FORMAT=json`.

---

## Session secret (`SESSION_SECRET`)

```env
SESSION_SECRET=a-long-random-value-from-openssl-rand-hex-32
```

This value is the **secret key used to sign the admin portal’s session cookie**.

When you log in to the admin UI, Express creates a **new** session id (`session.regenerate`) and stores a cookie in your browser (`bms.sid`). That cookie is **signed** with `SESSION_SECRET` so the server can tell:

1. The cookie was issued by **this** server  
2. It was not **tampered with**

If the secret is wrong or changed, existing sessions become invalid and you must log in again.

### Why the default is only for local testing

In development, a well-known placeholder is used if `SESSION_SECRET` is unset. Anyone who knows that value can more easily forge session cookies. **Production refuses to start** with a missing, short, or placeholder secret.

### How to generate a strong secret

Either command prints a 64-character hex string (32 random bytes):

```bash
openssl rand -hex 32
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Local `.env`**

```env
SESSION_SECRET=paste-the-output-here
```

Then restart the server (`npm start`) and log in again at the admin portal (old cookies will no longer validate).

**Docker Compose / shell**

```bash
export SESSION_SECRET="$(openssl rand -hex 32)"
export ADMIN_PASSWORD='your-strong-password'
```

Keep `SESSION_SECRET` private. Do not commit `.env` (it is listed in `.gitignore`).

### Related credentials

| Variable | Used for |
|---|---|
| `ADMIN_PASSWORD` | Admin web login (who you are) |
| `SESSION_SECRET` | Signing the cookie after login (proves the session is genuine) |
| User **API key** | Auth for the REST API / extension (not the admin web UI) |

---

## Reset admin password

If you forgot the admin password or changed `.env` and still can’t log in:

1. In `.env` set the desired credentials and enable reset:

   ```env
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=your-new-password
   RESET_ADMIN_PASSWORD=true
   ```

2. Restart the server (`npm start`).
3. Confirm the log line: `Reset admin login from .env …`
4. Set `RESET_ADMIN_PASSWORD=false` (or remove the line) and restart again.
5. Log in at the admin portal with the new password.

---

## Admin portal (v1)

Base URL: `http://127.0.0.1:<ADMIN_PORT>/`

| Path | Description |
|---|---|
| `GET /login` | Login form (username + password) |
| `POST /login` | Authenticate (session cookie) |
| `POST /logout` | End session |
| `GET /` | User list + create form (admins only) |
| `POST /users` | Create user |
| `POST /users/:id/regenerate-key` | Issue a new API key |
| `POST /users/:id/password` | Set password |
| `POST /users/:id/enable` / `disable` | Activate / deactivate |
| `POST /users/:id/delete` | Delete user and their bookmarks |

Only users with the **admin** flag can use this UI. Non-admin accounts are for API access only (for now).

---

## API (multi-user)

Base URL: `http://127.0.0.1:<SERVER_PORT>/`

### Public (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/info` | Minimal public status (`name`, `version`, `status`, `message`, `allowNewSyncs`, …) |
| `GET` | `/` | Short API landing page |

### Authenticated (per-user API key)

Send the key from the admin UI for that user:

```http
Authorization: Bearer bms_<key>
```

or:

```http
X-API-Key: bms_<key>
```

All routes below operate **only on that user’s bookmarks**.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/bookmarks` | List (`?folder=`, `?includeDeleted=true`) |
| `GET` | `/api/bookmarks/:id` | Get one |
| `POST` | `/api/bookmarks` | Create |
| `PUT` | `/api/bookmarks/:id` | Update (optimistic lock; see below) |
| `DELETE` | `/api/bookmarks/:id` | Soft-delete (`?hard=true` permanent; optimistic lock) |
| `POST` | `/api/bookmarks/sync` | Merge push by `updatedAt` (see conflict handling) |
| `GET` | `/api/bookmarks/export` | JSON export |
| `POST` | `/api/bookmarks/import` | Same merge rules as sync |

Invalid or missing key → `401`. Data from other users is never returned.

### Conflict handling

Multi-device safety uses **`updatedAt`** (ISO-8601) as an optimistic version token. No E2E encryption is involved.

#### Single-item writes (`PUT` / `DELETE`)

1. Client `GET`s a bookmark and keeps `updatedAt`.
2. On `PUT`, send the **same** `updatedAt` in the body (plus changed fields).
3. Server applies the change only if it still matches; then sets a new `updatedAt`.
4. If the server row changed → **`409 Conflict`** with the current `server` object.

```bash
# Update (must include updatedAt from last GET)
curl -s -X PUT "$BASE/api/bookmarks/$ID" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"New title\",\"updatedAt\":\"$UPDATED_AT\"}"
```

| Situation | HTTP | Notes |
|---|---|---|
| `updatedAt` matches | `200` | Write applied |
| `updatedAt` missing | `400` | `missing_updated_at` |
| `updatedAt` differs | `409` | `conflict` + `server` bookmark |
| Force overwrite | `200` | `?force=true` or `"force": true` skips the check |

Delete:

```bash
curl -s -X DELETE "$BASE/api/bookmarks/$ID?updatedAt=$UPDATED_AT" \
  -H "Authorization: Bearer $USER_API_KEY"

# Permanent
curl -s -X DELETE "$BASE/api/bookmarks/$ID?hard=true&updatedAt=$UPDATED_AT" \
  -H "Authorization: Bearer $USER_API_KEY"

# Force delete without version check
curl -s -X DELETE "$BASE/api/bookmarks/$ID?force=true" \
  -H "Authorization: Bearer $USER_API_KEY"
```

Create with a client-chosen `id` that already exists → **`409`**.

#### Sync / import (`POST /api/bookmarks/sync`)

Body:

```json
{
  "bookmarks": [ { "id": "...", "title": "...", "url": "...", "updatedAt": "..." } ],
  "replace": false,
  "lastSyncAt": "2026-07-13T12:00:00.000Z",
  "force": false
}
```

Per bookmark (same user):

| Case | Action |
|---|---|
| No server row | **Create** |
| Client `updatedAt` **newer** than server | **Update** server |
| Client `updatedAt` **older** than server | **Skip**; listed in `conflicts` (`server_newer`) |
| Same `updatedAt`, fields unchanged | **Unchanged** |
| Same `updatedAt`, but title/url/folder/position/notes/tags/favicon differ | **Update** (reorder / content fix; server bumps `updatedAt`) |
| `force: true` | Always apply client values |

`replace: true` soft-deletes server bookmarks **not** in the payload:

- With **`lastSyncAt`**: only deletes rows whose `updatedAt` is **≤** `lastSyncAt` (does not wipe newer server-only edits).
- Without `lastSyncAt`, or with **`force: true`**: aggressive replace (client membership wins).

Example response:

```json
{
  "created": 1,
  "updated": 2,
  "unchanged": 5,
  "skipped": 1,
  "deleted": 0,
  "processed": 9,
  "conflicts": [
    {
      "id": "...",
      "reason": "server_newer",
      "server": { },
      "client": { }
    }
  ],
  "count": 8,
  "bookmarks": [ ],
  "lastSyncAt": "..."
}
```

Clients (e.g. a browser extension) should store `lastSyncAt`, send it on the next sync, and resolve `conflicts` locally when needed.

### Bookmark object

```json
{
  "id": "uuid",
  "userId": "uuid",
  "title": "Example",
  "url": "https://example.com",
  "folder": "Work/Tools",
  "tags": ["dev", "docs"],
  "notes": "",
  "favicon": null,
  "position": 0,
  "createdAt": "2026-07-13T12:00:00.000Z",
  "updatedAt": "2026-07-13T12:00:00.000Z",
  "deletedAt": null
}
```

### Example requests

```bash
# API port (not admin port)
export BASE=http://127.0.0.1:31059
# Copy from admin UI for this user
export USER_API_KEY='bms_...'

# List (only this user's bookmarks)
curl -s "$BASE/api/bookmarks" \
  -H "Authorization: Bearer $USER_API_KEY"

# Create
curl -s -X POST "$BASE/api/bookmarks" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Example","url":"https://example.com","folder":"Work","tags":["demo"]}'

# Full sync (replace this user's set)
curl -s -X POST "$BASE/api/bookmarks/sync" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"replace":true,"bookmarks":[{"title":"A","url":"https://a.example"}]}'

# Export
curl -s "$BASE/api/bookmarks/export" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -o bookmarks-export.json
```

---

## Docker

`.dockerignore` excludes `.env`, `data/`, and `node_modules/` so secrets and the SQLite DB are never copied into image layers.

Expose **both** ports and pass **strong** secrets (production fails closed without them):

```bash
docker build -t bookmarks-sync:latest .

docker run -d \
  --name bookmarks-sync \
  -p 31059:31059 \
  -p 31060:31060 \
  -e SERVER_PORT=31059 \
  -e ADMIN_PORT=31060 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='your-strong-password' \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e DB_PATH=/app/data/bookmarks.db \
  -e NODE_ENV=production \
  -v bookmarks-sync-data:/app/data \
  bookmarks-sync:latest
```

### docker-compose

Set secrets in the environment (or a local `.env` next to Compose — not baked into the image):

```bash
export ADMIN_PASSWORD='your-strong-password'
export SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```

`docker-compose.yml` requires `ADMIN_PASSWORD` and `SESSION_SECRET` (no weak defaults). Database file: `/app/data/bookmarks.db` inside the volume.

---

## Browser extension (Chrome / Brave / Firefox)

Companion **Manifest V3** extension: [`bookmarks-extension/`](./bookmarks-extension/).  
Full reference (options, strategies, troubleshooting): **[bookmarks-extension/README.md](./bookmarks-extension/README.md)**.

### Overview

| | |
|---|---|
| **Browsers** | Chrome 116+, Brave, Firefox 128+ |
| **Auth** | Per-user API key (`Authorization: Bearer bms_…`) |
| **Talks to** | API port (`SERVER_PORT`), **not** the admin UI port |
| **Chromium install** | Load **unpacked** → `bookmarks-extension/chrome/` |
| **Firefox install** | Load temporary add-on → `bookmarks-extension/firefox/` |

The extension does **not** use the admin password. Create a normal user (or use an admin’s API key) in the admin portal, copy the key, and paste it into extension Options.

### Server checklist before installing the extension

1. Server is running (`npm start` or Docker).
2. Admin portal is reachable; you have created a **user** (or use admin).
3. Copy that user’s **API key** (copy button in the users table).
4. Note the **API** base URL only, for example:

   | Setup | Example API base URL |
   |---|---|
   | Local default ports | `http://127.0.0.1:31059` |
   | Custom `.env` `SERVER_PORT` | `http://127.0.0.1:31039` |
   | Behind reverse proxy | `https://bookmarks.example.com` |

   Do **not** use `ADMIN_PORT` (e.g. 31060) in the extension.

5. Optional: if a web page will call the API cross-origin, set `CORS_ORIGINS` (extension `fetch` from a background script usually does **not** need CORS).

### Install — Chrome / Brave

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select:

   ```text
   bookmarks-sync/bookmarks-extension/chrome
   ```

4. Open the extension **Options** (or toolbar popup → **Settings**).
5. Set **API base URL** and **API key** → **Save** (allow host access when the browser prompts).
6. **Test connection**, then **Sync now** from the popup.

### Install — Firefox

**Permanent (recommended — works on release Firefox):**

A **Mozilla-signed** XPI is in the repo:

```text
dist/bookmarks-sync-firefox-0.9.2.xpi
```

1. `about:addons` → gear → **Install Add-on From File…**
2. Choose that `.xpi` → confirm → **Options** → API URL + key → **Save**.

Full steps, updates, and self-sign workflow:  
[bookmarks-extension/FIREFOX-INSTALL.md](./bookmarks-extension/FIREFOX-INSTALL.md)

**Temporary (dev only — removed when Firefox quits):**

1. `npm run ext:sync`
2. `about:debugging` → Load Temporary Add-on → `bookmarks-extension/firefox/manifest.json`

Do **not** load `bookmarks-extension/chrome/` into Firefox.

### What the extension can do

| Feature | Description |
|---|---|
| **Sync now** | Manual full sync from the toolbar popup |
| **Test connection** | Hits `/health`, `/info`, and authenticated list |
| **Change-based sync** | Debounced sync after local bookmark create/edit/move/delete |
| **Sync on startup** | Sync a few seconds after the browser profile starts |
| **Time-based sync** | Periodic alarm (default interval **15** minutes) |
| **Merge** (default) | Keep compatible changes from this browser and the server |
| **Download** | Server wins — overwrite this browser from the server |
| **Upload** | This browser wins — force local tree onto the server |

### Extension settings (Options page)

**Server**

- API base URL  
- API key  

**Sync behaviour**

- Change-based synchronization (on/off)  
- Sync on startup (on/off)  
- Time-based synchronization (on/off) + interval in minutes  

**Synchronization strategy** (one of)

- Always merge local changes with changes from other browsers *(recommended)*  
- Always undo local changes and download from other browsers  
- Always upload local changes and undo changes from other browsers  

**Advanced**

- Where *new* server bookmarks are created (Other Bookmarks / Bookmarks Bar)  
- Remove local bookmarks deleted on the server  

### API endpoints the extension uses

| Method | Path | When |
|---|---|---|
| `GET` | `/health` | Connection test |
| `GET` | `/info` | Connection test |
| `GET` | `/api/bookmarks` | Auth test; **download** strategy |
| `POST` | `/api/bookmarks/sync` | **merge** and **upload** strategies |

Auth header:

```http
Authorization: Bearer bms_<your-user-api-key>
```

### Troubleshooting (extension)

| Symptom | What to check |
|---|---|
| Network / host permission error | Re-save Options and **Allow** access to the API origin |
| `401 Unauthorized` | Wrong/expired API key; regenerate in admin UI and paste again |
| Sync hits wrong service | URL must be **API** port, not admin port |
| `service_worker is currently disabled` | Load `bookmarks-extension/firefox/`, not `chrome/` |
| Firefox missing latest UI/code | Run `npm run ext:sync`, then reload the temporary add-on |
| Firefox extension gone after close | Temporary add-on only lasts one session — install the signed `dist/bookmarks-sync-firefox-*.xpi` ([FIREFOX-INSTALL.md](./bookmarks-extension/FIREFOX-INSTALL.md)) |
| Changes not pushing | Strategy set to **Download**? Switch to **Merge** or **Upload** |
| Server rejects large payload | Raise `MAX_SYNC_SIZE_BYTES` or split/clean bookmarks |

More detail: [bookmarks-extension/README.md](./bookmarks-extension/README.md).

---

## License

MIT
