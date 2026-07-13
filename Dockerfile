# Bookmarks Sync — API + admin UI
FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1001 app \
  && useradd --uid 1001 --gid app --shell /bin/false --create-home app

WORKDIR /app

COPY --from=build --chown=app:app /app /app

RUN mkdir -p /app/data && chown -R app:app /app/data

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=31059 \
    ADMIN_PORT=31060 \
    DB_PATH=/app/data/bookmarks.db

VOLUME ["/app/data"]
EXPOSE 31059 31060

USER app

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
