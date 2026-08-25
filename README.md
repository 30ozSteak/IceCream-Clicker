# FatBoy Clicker

A one-screen Three.js browser clicker game for FatBoy ice cream sandwiches.
Players pick a nickname, toss a textured 3D FatBoy at the mouth of locally
cached synthetic portraits, and compete on a public top-10 leaderboard.

## Local development

Requirements: Node.js 22.13 or newer.

Copy `.env.example` to `.env.local`, set `DATABASE_URL` to a Postgres
connection string, and set `ROUND_TOKEN_SECRET` to a random value containing at
least 32 UTF-8 bytes.

```bash
npm ci
npm run dev
```

For Vercel, connect a Postgres provider such as Neon from the Storage section of
the project dashboard. Vercel supplies `DATABASE_URL`; add
`ROUND_TOKEN_SECRET` to the project environment variables before deploying.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run db:generate
```

`npm test` runs the production Next.js build and the API/game contract tests.
Generate Postgres migrations with `npm run db:generate`, then apply them with
`npm run db:migrate` while `DATABASE_URL` is available in the shell.

## API

- `GET /api/game` creates or restores the anonymous browser session.
- `PATCH /api/player` validates and saves the nickname.
- `POST /api/feed` validates a signed one-use round and mouth click.
- `POST /api/pack` starts or completes a timed reload; perfect timing adds a
  seventh treat to the next pack.
- `GET /api/leaderboard` returns the cached leaders and visible global total.
- `DELETE /api/player` deletes progress and expires the session cookie.

Progress is stored in Postgres. The browser receives a 365-day secure,
HTTP-only session cookie; the database stores only its SHA-256 hash. No email,
raw IP address, user agent, click coordinate, or round token is retained.

## Assets

Brand assets and portrait provenance are documented alongside the local asset
library. Portraits are imported at build time, never requested from a third-party
API during play.
