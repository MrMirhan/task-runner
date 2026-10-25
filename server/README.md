# Task Runner server

A small Cloudflare Worker that keeps your rules and device names for every machine you sign in from, and serves the web page that edits them. It stores nothing else.

- One Durable Object (SQLite) holds the data.
- One secret, `TASK_RUNNER_KEY`, unlocks the API and the web page. The Worker refuses a key shorter than 24 characters.
- The web page is the dashboard build in `../dist/dashboard`. Run `npm run build:dashboard` in the repository root first.

```bash
npm install
npx wrangler deploy
npx wrangler secret put TASK_RUNNER_KEY      # openssl rand -hex 24
```

`wrangler deploy` creates a Worker called `task-runner-rules`. Change `name` in `wrangler.jsonc` for another name. It does not touch any other Worker in your account.

Try it without deploying:

```bash
npx wrangler dev --local --var "TASK_RUNNER_KEY:a-long-test-key-0123456789"
```

API: see the comment at the top of `../src/core/rules-api.ts`. `GET /api/health` is public. Every other call needs `Authorization: Bearer <key>`.
