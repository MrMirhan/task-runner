---
name: task-runner
description: Use the task-runner memory tools and task loop. Load when the work needs earlier decisions or pitfalls, when you learn something durable, when a change spans several steps, or when the user mentions memory, remembering or the knowledge graph.
---

# task-runner

Memory that survives sessions (a knowledge graph plus notes) and a task runner. The `task-runner` MCP server stores everything in a local SQLite file. The project comes from the working directory. You never pass it.

## At session start

A briefing of the most important facts is already in your context. For anything beyond it, call `recall` with a few keywords before you re-derive or re-ask. Search ignores accents and matches word starts, so `calisma` finds `çalışma` and `migrat` finds `migrations`.

## While you work

Write down what you would want to know next time, when it happens:

| You learned | Call |
| --- | --- |
| A decision and its reason | `remember` with type `decision` |
| A trap that cost time | `remember` with type `pitfall` |
| A rule the project follows | `remember` with type `convention` |
| How the user likes to work | `remember` with `scope: "global"` (holds in every project) |
| A repeatable approach | `remember` with type `pattern` |
| What happened in this session | `save_memory` |

Rules that keep the graph useful:

- Keep the name short (80 characters at most). Put the sentence in `observations`.
- One fact per item, under 1000 characters. Long text goes in `save_memory`.
- `remember` on a name that exists adds facts to it. Duplicates are skipped.
- `remember` returns `similar_existing` when a close match exists. Use that entity instead of a new one.
- Connect related entities with `link` (`uses`, `depends_on`, `supersedes`, `decided_against`, `relates_to`, ...).
- A fact is wrong or old: call `correct_fact` with the fact id from `recall` or `what_do_i_know`. Never add a second fact that contradicts the first.
- Facts show their date. Check old facts against the code before you rely on them. The code wins.
- Do not store secrets, tokens or personal data.

## Multi-step work

For three or more dependent steps, split the work:

1. `create_task_group` with `## Task 1: Title` sections, or a `tasks` array.
2. Repeat: `get_next_task`, do the task (a subagent keeps the main context clean), then `complete_task` with a short result. Use `status: "failed"` and the reason when it fails.
3. `get_task_status` shows progress. With `task_id` it returns one task in full.

A task that stays `running` for 30 minutes is offered again by `get_next_task`.

## Housekeeping

- `graph_stats` shows counts and orphan entities (no relations). With `check: true` it also lists old entities and file entities whose path no longer exists.
- `forget` retires an entity.
- The user opens the panel with `/brain`, searches with `/recall <keywords>` and saves a note with `/remember <text>`.
