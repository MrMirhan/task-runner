---
name: task-runner
description: Use the task-runner memory tools and task loop. Load when the work needs earlier decisions or pitfalls, when you learn something durable, when a change spans several steps, or when the user mentions memory, remembering or the knowledge graph.
---

# task-runner

Memory that survives sessions (a knowledge graph plus notes) and a task runner. The `task-runner` MCP server stores everything in one database: a local SQLite file, or the user's own server when this machine is signed in. The project comes from the working directory. You never pass it.

## At session start

The section "How the user wants things" lists preferences learned from what the user said. Follow them; when the current request says otherwise, the request wins and the preference is updated.

A briefing of the most important facts is already in your context. For anything beyond it, call `recall` with a few keywords before you re-derive or re-ask. Search ignores accents and matches word starts and stems, so `calisma` finds `çalışma` and `migrations` finds `migration`. It does not match meaning: if the first search misses, try synonyms and the other language. `related` lists entities linked to the hits.

## While you work

Write down what you would want to know next time, when it happens:

| You learned | Call |
| --- | --- |
| A decision and its reason | `remember` with type `decision` |
| A trap that cost time | `remember` with type `pitfall` |
| A rule the project follows | `remember` with type `convention` |
| How the user wants things done (a directive, a correction, a preference) | `taste` with action `learn` (in Claude Code the panel also learns these by itself) |
| A fact about the user that holds in every project | `remember` with `scope: "global"` |
| A repeatable approach | `remember` with type `pattern` |
| What happened in this session | `save_memory` |

Rules that keep the graph useful:

- Keep the name short (80 characters at most). Put the sentence in `observations`.
- One fact per item, under 1000 characters. Long text goes in `save_memory`.
- `remember` on a name that exists adds facts to it. Duplicates are skipped.
- Give `keywords` with every new entity: synonyms, abbreviations and the term in the user's language ("auth, login, oturum açma"). Search matches words, not meaning, so keywords are what makes a fact findable later.
- `remember` returns `similar_existing` when a close match exists: use that entity instead of a new one. Entities named in your facts are linked automatically (`auto_linked`); remove a wrong link with `link` and `remove: true`.
- `possible_conflicts` means a stored fact says something different about the same point. Fix the old one with `correct_fact`.
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

## Rules

The user's standing rules arrive at the top of your context ("RULES from the user"). Follow them. Call `rules` with `action: "show"` to see them again.

Preferences the user states or corrections they give go to `taste` (above), which applies them at once. Call `rules` with `action: "propose"` only when the user asks for a standing rule in so many words ("make this a rule", "add a rule"). Pick the narrowest scope that fits (`project` before `org` before `global`), write one short imperative sentence, and give a reason. This only queues the proposal; the user approves it. Tell the user you proposed it. Never propose secrets, one-time instructions, or what the code already shows.

## Housekeeping

- `graph_stats` shows counts and orphan entities (no relations). With `check: true` it also lists old entities and file entities whose path no longer exists.
- `forget` retires an entity.
- `worklog` answers questions about time: how long the user and the agents worked this week, on which project, feature or fix, and what was done. Use `detail: true` when the user wants to know what was done, not only how long.
- The user opens the panel with `/brain`, searches with `/recall <keywords>` and saves a note with `/remember <text>` and sees time with `/worklog`.
