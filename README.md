# Ice Cream Clicker

A one-screen browser clicker game about ice cream sandwiches. Players pick a
nickname, toss a sandwich at the mouth of locally cached synthetic portraits,
and compete on a public top-10 leaderboard.

The projectile renders as a CSS illustration. A Three.js path is still wired up
in `app/SandwichProjectile.tsx`; point `SANDWICH_MODELS.vanilla` at a GLB under
`public/models` to turn it back on.

## Local development

Requirements: Node.js 22.13 or newer.

The shared Vercel project uses a Vercel-managed Neon Postgres database. Link the
checkout and pull its development credentials; secret values stay in the
gitignored `.env.local` file.

```bash
npm ci
npx vercel link
npx vercel env pull .env.local --yes
npm run db:migrate
npm run dev
```

If you do not have access to the shared Vercel project, copy `.env.example` to
`.env.local` and supply a Neon `DATABASE_URL` plus a random
`ROUND_TOKEN_SECRET` containing at least 32 UTF-8 bytes. The runtime uses Neon's
serverless HTTP driver, so a connection string from an arbitrary Postgres host
is not interchangeable.

### Provisioning a new Vercel project

Only use this flow for a new project that does not already have a database. It
creates a free Neon resource in the same region as this app, connects it to all
three Vercel environments, and pulls the development values locally.

```bash
npx vercel link
npx vercel integration add neon --name icecream-clicker-db --plan free_v3 --metadata region=iad1 --metadata auth=false --no-claim
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx vercel env add ROUND_TOKEN_SECRET production,preview,development --yes
npx vercel env pull .env.local --yes
npm run db:migrate
```

Never commit `.env.local` or print its values. Confirm configuration by listing
environment variable names with `npx vercel env ls`.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run db:generate
```

`npm test` runs the production Next.js build and the API/game contract tests.
Generate Postgres migrations with `npm run db:generate`, then apply them with
`npm run db:migrate`. The Drizzle config loads `.env.local` when it exists and
otherwise uses `DATABASE_URL` from the current shell.

`drizzle-postgres/` is the only live migration history. The older `drizzle/`
directory and `db/schema-maintenance.ts` are retained solely as fixtures for
legacy SQLite migration tests and must not be applied to Postgres.

## API

- `GET /api/game` creates or restores the anonymous browser session.
- `PATCH /api/player` validates and saves the nickname.
- `POST /api/feed` validates a signed one-use round and mouth click.
- `POST /api/pack` starts or completes a timed reload; perfect timing opens the
  next box early, while missed timing safely auto-finishes.
- `GET /api/leaderboard` returns the cached leaders and visible global total.
- `DELETE /api/player` deletes progress and expires the session cookie.

Progress is stored in Postgres. The browser receives a 365-day secure,
HTTP-only session cookie; the database stores only its SHA-256 hash. No email,
raw IP address, user agent, click coordinate, or round token is retained.

## Assets

Brand assets and portrait provenance are documented alongside the local asset
library. Portraits are imported at build time, never requested from a third-party
API during play.
