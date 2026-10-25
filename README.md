# Task Runner

Memory for your coding agent. It remembers decisions, pitfalls and conventions between sessions. It also runs multi-step work as a task list.

Task Runner is one package with four parts:

- an **MCP server** with 17 tools (works in any MCP client),
- a **Claude Code plugin** that wires the server, a session briefing and a skill together,
- a **mod** for Claude Code: a live side panel, memory toasts, task progress, reminders and a time report,
- a **local dashboard** with a graph view.

All data stays in one SQLite file on your machine. Nothing is sent anywhere.

## Install

### Claude Code (recommended)

```text
/plugin install task-runner --marketplace MrMirhan/claude-task-runner-mcp
```

From a shell:

```bash
claude plugin install task-runner --marketplace MrMirhan/claude-task-runner-mcp
```

You need Node.js 22.13 or newer. Start a new session. The plugin adds:

| Part | What it does |
| --- | --- |
| MCP server | The 17 memory, task and time tools. |
| Session briefing | At session start, a hook puts the most important facts of the project in the agent's context. The agent does not need to call a tool to get them. |
| Skill | Tells the agent when and how to use the tools. |
| Panel (`/brain`) | Tasks, notes and the knowledge graph next to the chat. Updates while the agent works. |
| `/recall <words>` | Search memory without using a model turn. |
| `/remember <text>` | Save a note. |
| `/worklog [week]` | Time spent by you and the agent, per project and task. |
| Toasts | Show what the agent remembers, links or forgets. |
| Progress line | Shows task progress above the prompt while a task group is open. |
| Commit notes | Saves a short note for each `git commit` the agent makes. No model call. |
| Reminder | After many edits or a commit with nothing saved, adds one line to your next prompt. |
| No prompts | The plugin approves its own memory tools, so they never stop to ask. `clear_tasks` still asks. |

Each of the last five rows has a switch in the plugin settings.

### Other MCP clients

Add the server to the client configuration:

```json
{
  "mcpServers": {
    "task-runner": { "command": "npx", "args": ["-y", "task-runner-mcp"] }
  }
}
```

The server finds the project from its working directory. If your client starts servers in another directory, set `TASK_RUNNER_PROJECT`:

```json
{
  "mcpServers": {
    "task-runner": {
      "command": "npx",
      "args": ["-y", "task-runner-mcp"],
      "env": { "TASK_RUNNER_PROJECT": "my-project" }
    }
  }
}
```

Other clients do not get the briefing, the panel or the slash commands. The tools and their instructions work everywhere.

## How the agent uses it

1. The briefing shows the top facts for the project and for you.
2. The agent calls `recall` for details. Search ignores accents and matches word starts, in any language.
3. While it works, the agent calls `remember` for durable facts and `link` to connect them. `save_memory` is for notes about the session.
4. A wrong fact is fixed with `correct_fact`. Every fact has a date.
5. For long work, the agent calls `create_task_group`, then loops `get_next_task` and `complete_task`.

### Tools

| Tool | Purpose |
| --- | --- |
| `recall` | Search entities, facts and notes. |
| `remember` | Create an entity or add facts to it. `scope: "global"` is for facts about you. |
| `link` | Connect two entities. |
| `correct_fact` | Replace or retire one fact. |
| `what_do_i_know` | One entity with facts, relations and neighbors. |
| `forget` | Retire an entity. |
| `save_memory`, `get_context` | Session notes. |
| `graph_stats` | Counts, orphan entities and (with `check`) stale items. |
| `create_task_group`, `get_next_task`, `complete_task`, `get_task_status`, `clear_tasks` | The task loop. |
| `worklog` | Time by you and the agent per project and task, for a period. Local install only. |
| `set_context`, `list_projects` | Override or inspect the project. Rarely needed. |

Entity types: `preference`, `decision`, `pattern`, `file`, `concept`, `tool`, `pitfall`, `convention`.
Relations: `uses`, `depends_on`, `conflicts_with`, `part_of`, `prefers_over`, `decided_against`, `relates_to`, `supersedes`.

## Projects

The project key comes from the first match in this list:

1. the `TASK_RUNNER_PROJECT` environment variable,
2. a `.task-runner.json` file in the repository root: `{ "project": "my-project" }`,
3. a project already stored for the same folder,
4. the git remote, as `owner-repo` in lowercase (so clones and worktrees agree),
5. the folder name.

Commit `.task-runner.json` when a team wants one key for everybody.

Worktrees and copies share the project key. A linked `git worktree` (for example an Orca workspace) uses the key of its main checkout. A plain copy of the folder keeps the git remote, so it gets the same key. Every folder a project was seen in is remembered.

What stays separate:

| Thing | How |
| --- | --- |
| Session | Each agent session runs its own server process with its own folder and branch. |
| Worktree or branch | Task groups belong to the branch that made them. `get_next_task` and the panel show only the groups of the current branch. Notes carry a `branch:<name>` tag, and `scope: "branch"` hides a note from other branches. |
| Project | Entities, facts and notes are shared by every worktree of the project, so a lesson learned in one worktree is there in the next. |
| You | `scope: "global"` facts show in every project. |

## Time tracking

Task Runner reads your Claude Code session transcripts and tells you how long you worked, how long the agents worked, and on what. It needs no hook and no setup, and it works on the history you already have.

```bash
npx task-runner-mcp worklog                      # this week, all projects
npx task-runner-mcp worklog --today --detail     # plus what you asked and what was saved
npx task-runner-mcp worklog --last-week --format md > week.md
npx task-runner-mcp worklog --month --project . --format csv   # this project, for a spreadsheet
```

Ask the agent too: "how long did I work on the checkout feature this week, and what did we do?" The `worklog` tool answers from the same data.

How the numbers are made:

| Number | Meaning |
| --- | --- |
| **You** | The time before each prompt you typed (reading, thinking, typing). A wait longer than 5 minutes counts as 5; longer is a break. |
| **Agent** | The time agents worked between your prompts. A pause longer than 15 minutes counts as 15. Parallel sessions add up, so this can exceed the clock. |
| **Wall clock** | Every minute with any activity, counted once. This is the number to compare with a calendar. |

A **task** is a branch. A ticket key in the branch name (`feat/PPG-1182-login` gives `PPG-1182`) is the task label, and the prefix tells feature from fix. Work on `main` or without a branch has its own rows. A session that starts in a plain folder is charged to the repository whose files it edits.

Next to the time you see what you asked first, how many prompts and file edits it took, the commit notes, the notes you saved on that branch and the task groups. The Time tab of the panel (`/brain`) and the dashboard show the same report.

Settings (flags, or the environment variables in brackets):

- `--human-cap <minutes>` and `--ai-cap <minutes>` change the two caps above. Changing them recomputes the history.
- `--exclude "app-*,scratch"` [`TASK_RUNNER_WORKLOG_EXCLUDE`] hides projects. `*` is a wildcard. Use it for tools that run agent sessions on their own.
- `worklog pending` lists time not yet reported. After you copy it to a time-tracking system, run `worklog exported <project> <branch>` so it is not reported twice.

The first run reads every transcript of the period and can take a minute for a heavy week. After that only changed files are read. The result is stored in the same local database. Claude Code removes old transcripts after some weeks, so run a report before they go; the stored numbers stay.

## Command line

```bash
npx task-runner-mcp doctor                       # check the installation
npx task-runner-mcp dashboard --open             # graph and notes in your browser
npx task-runner-mcp export --out backup.json     # all data as JSON
npx task-runner-mcp export --format markdown --out vault   # one file per entity, [[wiki links]]
npx task-runner-mcp import backup.json
npx task-runner-mcp projects                     # list projects
npx task-runner-mcp projects merge old-key new-key --yes
npx task-runner-mcp forget "Some entity"
npx task-runner-mcp note "Free text note"
```

The markdown export opens in Obsidian or any editor.

## Data and privacy

- The database is `~/.task-runner/memory.db`. Set `TASK_RUNNER_DB` for a file, or `TASK_RUNNER_HOME` for a folder.
- The plugin never opens a network connection. The dashboard listens on `127.0.0.1` only and refuses other hosts and origins.
- The reminder adds a line to your next prompt that only the agent reads. Switch it off with the `nudge` setting.
- Do not let the agent store secrets. The skill tells it not to, but nothing filters the text.
- Back up with `export`. Do not put the database in a cloud-synced folder; SQLite and file sync do not mix.

## Develop

```bash
npm install
npm run check          # type check and tests
npm run build          # bundle to dist/cli.js (committed: the plugin runs it)
npm run build:dashboard   # rebuild the web UI into dist/dashboard
claude plugin validate .
claude plugin test .   # mod tests
claude --plugin-dir .  # try the plugin in a session
```

Layout:

```text
src/core      store, schema, search, markdown export (no Node APIs)
src/mcp       tool definitions, server, session scope
src/node      node:sqlite driver, project detection
src/cli       command line, session hook, dashboard server
hooks         the mod (register.tsx) and the SessionStart hook
skills        the skill
dashboard     Next.js source of the web UI
```

## Moving from the hosted version

The old hosted version (Cloudflare Worker) is on the `main` branch. This version replaces it. The tool set changed:

| Old | New |
| --- | --- |
| `create_project` | `create_task_group` |
| `fail_task` | `complete_task` with `status: "failed"` |
| `get_task_summary`, `get_task_result` | `get_task_status` (add `task_id` for one task) |
| `add_facts` | `remember` on an existing name |
| `consolidate` | `graph_stats` with `check: true` |
| `search_memory` | `recall` (`all_projects: true` to search every project) |
| `clean` | `clear_tasks` (it no longer deletes memory) |
| `parse_task_list` | removed |

## License

MIT
