# Bookmarks Sync

**Version:** `0.1.0`

Self-hosted multi-user bookmark sync API for browsers and scripts. Admins manage users in a web portal; each user gets an API key and isolated bookmarks in SQLite. Designed to sit behind Caddy (or similar) for HTTPS, with a companion browser extension planned next—not a full xBrowserSync clone (no mandatory E2E encryption).

**Stack:** Node.js + Express + SQLite · **Auth:** admin session (UI) + per-user API keys (REST) · **Conflicts:** optimistic locking via `updatedAt` on writes; sync merges by newest timestamp.

**Multi-user model** (inspired by [Baikal](https://github.com/sabre-io/Baikal)-style admin accounts and [xBrowserSync](https://github.com/offsyanka99/xbrowsersync)-style sync):

| Who | How they authenticate | What they get |
|---|---|---|
| **Admin** | Username + password (web UI) | Create/manage users, view API keys |
| **Users** | Per-user **API key** (REST API / future extension) | Only their own bookmarks |

There is **no shared global API key**. Each user has a unique key; all bookmark operations are filtered by `user_id`.

---

## Architecture

Two HTTP ports run from one process (`server.js`):

| Port | Env | Purpose |
|---|---|---|
| **API** | `SERVER_PORT` (default `31059`) | REST API for bookmark sync |
| **Admin** | `ADMIN_PORT` (default `31060`) | Admin web portal only |

```
┌─────────────────────┐     ┌──────────────────────────┐
│  Admin UI           │     │  Bookmark Sync API       │
│  ADMIN_PORT         │     │  SERVER_PORT             │
│  /login  /          │     │  /health  /info          │
│  session cookie     │     │  /api/bookmarks/*        │
│  username+password  │     │  per-user API key        │
└─────────┬───────────┘     └────────────┬─────────────┘
          │                              │
          └──────────┬───────────────────┘
                     ▼
              SQLite (data/bookmarks.db)
              users + bookmarks (user_id)
```

---

## Project structure

```
bookmarks-sync/
├── package.json
├── server.js                 # Starts API + admin servers
├── .env / .env.example
├── Dockerfile
├── docker-compose.yml
├── public/
│   └── admin.css
├── data/
│   └── bookmarks.db          # Created on first start
├── src/
│   ├── routes/
│   │   ├── admin.js
│   │   └── bookmarks.js
│   ├── controllers/
│   │   ├── adminController.js
│   │   └── bookmarkController.js
│   ├── models/
│   │   ├── User.js
│   │   └── Bookmark.js
│   ├── middleware/
│   │   └── auth.js           # Session (admin) + API key (API)
│   ├── views/                # Server-rendered admin HTML
│   └── utils/
│       ├── db.js
│       ├── crypto.js
│       └── bootstrap.js
├── bookmarks-extension/      # Placeholder for browser extension
└── README.md
```

---

## Features

- **Multi-user**: admin creates accounts; no public signup
- **Admin portal** on a **separate port** from the API
- **Username + password** for admin web login
- **Per-user API keys** for `/api/bookmarks` (extension / scripts)
- Bookmarks **scoped by user** (`user_id`)
- SQLite (WAL mode), soft deletes, import/export, full sync
- Bootstrap admin from `.env`; optional password reset via env flag

**Not in v1 yet**

- End-user web UI for managing bookmarks in the browser
- Browser extension (folder reserved)

---

## Quick start (local)

```bash
cp .env.example .env
# Optional: change ADMIN_PASSWORD and SESSION_SECRET

npm install
npm start
```

Then open:

| Service | URL (defaults) |
|---|---|
| Admin portal | http://127.0.0.1:31060/login |
| API health | http://127.0.0.1:31059/health |

**Default admin login (first bootstrap):**

| Field | Default |
|---|---|
| Username | `admin` |
| Password | `admin` |

Change these before any real deployment. See [Session secret](#session-secret-session_secret) for `SESSION_SECRET`.

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

If `ADMIN_PASSWORD` is omitted, it defaults to `admin`. The server logs a warning when the default password is used.

The admin **API key** is printed once in the server log and is always visible in the admin UI.

> Changing `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` later does **not** update an existing admin. See [Reset admin password](#reset-admin-password).

### Create users

1. Log in to the admin portal (admin only in v1).
2. Create a user (username, password, optional display name).
3. Copy that user’s **API key**.
4. Use the key against the **API port** (not the admin port).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `31059` | Bookmark sync **API** port |
| `ADMIN_PORT` | `31060` | **Admin UI** port (must differ from API) |
| `SERVER_HOST` | `0.0.0.0` | Bind address for both ports |
| `ADMIN_USERNAME` | `admin` | Admin username on first bootstrap (or reset) |
| `ADMIN_PASSWORD` | `admin` | Admin password on first bootstrap (or reset) |
| `RESET_ADMIN_PASSWORD` | unset / `false` | Set to `true` once to re-apply admin login from `.env` |
| `SESSION_SECRET` | — | Signs admin session cookies (use a long random value) |
| `COOKIE_SECURE` | `false` | Set `true` when admin UI is served over HTTPS |
| `DB_PATH` | `./data/bookmarks.db` | SQLite database path |
| `ALLOW_NEW_SYNCS` | `true` | Set `false` to reject sync pushes |
| `MAX_SYNC_SIZE_BYTES` | `1048576` | Max request body size (1 MiB) |
| `STATUS_MESSAGE` | — | Message returned by `GET /info` |

`RESET_ADMIN_PASSWORD=false` (or omitted / commented out) is safe and does nothing. Only the value `true` triggers a reset.

---

## Session secret (`SESSION_SECRET`)

```env
SESSION_SECRET=dev-only-session-secret-change-me
```

This value is the **secret key used to sign the admin portal’s session cookie**.

When you log in to the admin UI, Express creates a session and stores a cookie in your browser (`bms.sid`). That cookie is **signed** with `SESSION_SECRET` so the server can tell:

1. The cookie was issued by **this** server  
2. It was not **tampered with**

If the secret is wrong or changed, existing sessions become invalid and you must log in again.

### Why the default is only for local testing

`dev-only-session-secret-change-me` is a **placeholder**. Anyone who knows that value can more easily forge or mess with session cookies. Fine on a private machine for development; **change it** before shared or internet-facing use.

### How to set a strong secret

1. Generate a long random string:

   ```bash
   openssl rand -hex 32
   ```

   Or with Node:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Put it in `.env`:

   ```env
   SESSION_SECRET=a3f8c1e9b2d04f6a7c8e1d9b0a4f3e2c...
   ```

3. Restart the server (`npm start`).
4. Log in again at the admin portal (old cookies will no longer validate).

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
| `GET` | `/info` | Service status (includes `multiUser`, ports, counts) |
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
| Same `updatedAt` | **Unchanged** |
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

Expose **both** ports and set admin bootstrap env vars:

```bash
docker build -t bookmarks-sync:latest .

docker run -d \
  --name bookmarks-sync \
  -p 31059:31059 \
  -p 31060:31060 \
  -e SERVER_PORT=31059 \
  -e ADMIN_PORT=31060 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=admin \
  -e SESSION_SECRET='long-random-secret' \
  -e DB_PATH=/app/data/bookmarks.db \
  -v bookmarks-sync-data:/app/data \
  bookmarks-sync:latest
```

### docker-compose example

```yaml
services:
  bookmarks-sync:
    build: .
    ports:
      - "31059:31059"   # API
      - "31060:31060"   # Admin UI
    environment:
      SERVER_PORT: "31059"
      ADMIN_PORT: "31060"
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      SESSION_SECRET: ${SESSION_SECRET}
      DB_PATH: /app/data/bookmarks.db
      STATUS_MESSAGE: Bookmarks Sync is online
    volumes:
      - bookmarks-data:/app/data
    restart: unless-stopped

volumes:
  bookmarks-data:
```

Database file: `/app/data/bookmarks.db` inside the volume.

---

## Browser extension

The `bookmarks-extension/` folder is reserved for a companion extension that will call the multi-user API with each user’s API key.

Until then, use `curl`, scripts, or any HTTP client against `SERVER_PORT`.

---

## License

MIT
