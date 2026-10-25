# Task Runner server

A Cloudflare Worker that holds your memory, tasks, time records and rules, so that every machine you sign in from uses the same data. It also serves the web page.

- `/mcp` is an MCP server (Streamable HTTP). It has the same tools as the local server.
- `/api/rpc` is for the `task-runner-mcp` CLI on a signed-in machine. `/api/*` is the JSON API for the web page.
- A Durable Object (SQLite) holds the data.
- The secret `TASK_RUNNER_KEY` unlocks everything except `GET /api/health`. The Worker refuses a key shorter than 24 characters.
- The web page is the dashboard build in `../dist/dashboard`. Run `npm run build:dashboard` in the repository root first.

## New server

```bash
npm install
npx wrangler deploy
npx wrangler secret put TASK_RUNNER_KEY      # openssl rand -hex 24
```

`wrangler deploy` creates a Worker called `task-runner`. To use a different name, change `name` in `wrangler.jsonc`. The deploy does not change other Workers in your account.

Then, on each machine:

```bash
task-runner-mcp login https://task-runner.<your-subdomain>.workers.dev
```

After login, the plugin's local MCP server, the session hook and the CLI read and write the server's data. To connect an MCP client directly, without the local server:

```bash
claude mcp add --transport http task-runner https://task-runner.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <key>"
```

A direct client can send `X-Task-Runner-Project`, `X-Task-Runner-Path`, `X-Task-Runner-Branch`, `X-Task-Runner-Org` and `X-Task-Runner-Device` headers to set the scope. If it sends no headers, the scope is the last `set_context` call.

## Upgrade a server from before 1.0

Before 1.0 the hosted server was a Worker called `claude-task-runner-mcp` with one key per tenant. Deploy `wrangler.legacy.jsonc` over it:

```bash
npx wrangler deploy -c wrangler.legacy.jsonc
```

- Every Durable Object stays. On the first request, each tenant's tables are copied into the current schema. The old tables stay in the same database as `legacy_*`, as a backup.
- The `ctr_...` keys that were issued before continue to work, and each key opens its own tenant's data.
- To use one new key instead, set `TASK_RUNNER_KEY` and set `TASK_RUNNER_TENANT` to the tenant id of the old key (`tenant-...`).
- The admin login and key management pages from before 1.0 are not available. The old secrets (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET`) are not used.

Do not remove a migration from `wrangler.legacy.jsonc`, and do not add a `deleted_classes` step. Either change deletes stored data permanently.

## Try it without deploying

```bash
npx wrangler dev --local --var "TASK_RUNNER_KEY:a-long-test-key-0123456789"
```
