# Task Runner dashboard

Static Next.js UI for the local `task-runner-mcp dashboard` server. It calls `/api` on its own origin.
Build: `npm install && npm run build`. The export lands in `out/`; the root `npm run build` copies it to `dist/dashboard`.
Run: `node ../dist/cli.js dashboard --port 4747`, then open http://127.0.0.1:4747.
Dev: `NEXT_PUBLIC_API_URL=http://127.0.0.1:4747/api npm run dev` points `next dev` at a running server (default `/api`).
The server refuses requests whose `Origin` is not its own, so the dev override needs a server that accepts `http://localhost:3000`.
