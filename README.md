# FatBoy Clicker

A one-screen browser clicker game for FatBoy ice cream sandwiches. Players pick
a nickname, feed locally cached synthetic portraits, and compete on a public
top-10 leaderboard.

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The Sites starter supplies a local Cloudflare runtime and D1 binding. Local
round tokens use the preview-only secret in `vite.config.ts`; hosted deployments
must set a separate `ROUND_TOKEN_SECRET` environment variable.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run db:generate
```

`npm test` runs the production build and the API/game contract tests. Database
migrations live in `drizzle/` and the app also initializes the same schema
idempotently for a brand-new Sites D1 database.

## API

- `GET /api/game` creates or restores the anonymous browser session.
- `PATCH /api/player` validates and saves the nickname.
- `POST /api/feed` validates a signed one-use round and mouth click.
- `POST /api/pack` atomically opens the next six-sandwich pack.
- `GET /api/leaderboard` returns the cached leaders and visible global total.
- `DELETE /api/player` deletes progress and expires the session cookie.

Progress is stored in Cloudflare D1. The browser receives a 365-day secure,
HTTP-only session cookie; the database stores only its SHA-256 hash. No email,
raw IP address, user agent, click coordinate, or round token is retained.

## Assets

Brand assets and portrait provenance are documented alongside the local asset
library. Portraits are imported at build time, never requested from a third-party
API during play.
