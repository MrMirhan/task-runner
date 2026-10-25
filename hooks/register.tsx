import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, SearchState, Snapshot, Tab, WorklogView } from '../types'

const PANE = 'brain'
const TITLE = 'Task Runner'

const snapshotValue = atom({ plugin: 'task-runner', key: 'snapshot' } as const, null)
const tabValue = atom({ plugin: 'task-runner', key: 'tab' } as const, 'tasks')
const detailValue = atom({ plugin: 'task-runner', key: 'detail' } as const, null)
const searchValue = atom({ plugin: 'task-runner', key: 'search' } as const, null)
const worklogValue = atom({ plugin: 'task-runner', key: 'worklog' } as const, null)

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'notes', label: 'Notes' },
  { id: 'graph', label: 'Graph' },
  { id: 'search', label: 'Search' },
  { id: 'time', label: 'Time' },
]

const GLYPH: Record<string, string> = { completed: '✓', failed: '✗', running: '▶', pending: '·' }

const MEMORY_TOOL = /^mcp__(?:plugin_task-runner_)?task-runner__(\w+)$/
const WRITES = new Set([
  'remember', 'add_facts', 'correct_fact', 'link', 'forget', 'save_memory',
  'create_task_group', 'complete_task', 'fail_task',
])
const SAVES_MEMORY = new Set(['remember', 'add_facts', 'correct_fact', 'link', 'save_memory'])
const FILE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Every tool only touches the local memory database; clear_tasks stays behind the normal rules.
const OWN_TOOL = /^mcp__plugin_task-runner_task-runner__(\w+)$/
const PROMPT_FREE = new Set([
  'set_context', 'list_projects', 'get_context', 'save_memory', 'remember', 'correct_fact', 'link', 'recall',
  'what_do_i_know', 'forget', 'graph_stats', 'create_task_group', 'get_next_task', 'complete_task', 'get_task_status',
])

// Work nobody awaits must not surface as an unhandled rejection when the session is gone.
function background(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

let isRefreshing = false
let wantsRefresh = false

// The CLI is the one reader of the database, so the panel and the MCP server never disagree.
async function cli<T>($: EngineInterface, args: string[]): Promise<T | null> {
  const cwd = await $.session.cwd()
  try {
    const ran = await $.process.run(['node', $.plugin.root + '/dist/cli.js', ...args, '--cwd', cwd], {
      timeoutMs: 15000,
    })
    if (ran.exitCode !== 0) {
      $.ui.log('task-runner: ' + (ran.stderr.trim().split('\n')[0] || 'command failed'))
      return null
    }
    return JSON.parse(ran.stdout) as T
  } catch (error) {
    $.ui.log('task-runner: ' + String(error))
    return null
  }
}

// A first scan reads the transcripts on disk, so worklog calls get a long limit.
const WORKLOG_TIMEOUT_MS = 180000

async function cliText($: EngineInterface, args: string[]): Promise<string | null> {
  const cwd = await $.session.cwd()
  try {
    const ran = await $.process.run(['node', $.plugin.root + '/dist/cli.js', ...args, '--cwd', cwd], {
      timeoutMs: WORKLOG_TIMEOUT_MS,
    })
    return ran.exitCode === 0 ? ran.stdout.trimEnd() : null
  } catch (error) {
    $.ui.log('task-runner: ' + String(error))
    return null
  }
}

async function loadWorklog($: EngineInterface): Promise<void> {
  const raw = await cliText($, ['worklog', '--week', '--format', 'json'])
  if (!raw) return
  try {
    const report = JSON.parse(raw) as {
      range: { label: string }
      totals: WorklogView['totals']
      rows: WorklogView['rows']
      days: WorklogView['days']
    }
    const view: WorklogView = {
      label: report.range.label,
      totals: report.totals,
      rows: report.rows.slice(0, 14),
      days: report.days,
    }
    await update($, worklogValue, () => view)
  } catch {
    $.ui.log('task-runner: could not read the time report')
  }
}

function hours(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm' : minutes + 'm'
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    wantsRefresh = true
    return
  }
  isRefreshing = true
  try {
    do {
      wantsRefresh = false
      const snapshot = await cli<Snapshot>($, ['snapshot'])
      if (snapshot) await update($, snapshotValue, () => snapshot)
    } while (wantsRefresh)
  } finally {
    isRefreshing = false
  }
}

async function openDetail($: EngineInterface, name: string): Promise<void> {
  const raw = await cli<{
    entity: { name: string; entity_type: string; summary: string | null }
    observations: Array<{ content: string }>
    relations: {
      outgoing: Array<{ relation_type: string; target_name: string }>
      incoming: Array<{ relation_type: string; source_name: string }>
    }
  }>($, ['snapshot', '--entity', name])
  if (!raw) return
  const detail: Detail = {
    name: raw.entity.name,
    type: raw.entity.entity_type,
    summary: raw.entity.summary,
    facts: raw.observations.map(fact => fact.content),
    relations: [
      ...raw.relations.outgoing.map(r => r.relation_type + ' → ' + r.target_name),
      ...raw.relations.incoming.map(r => r.source_name + ' → ' + r.relation_type + ' this'),
    ],
  }
  await update($, detailValue, () => detail)
}

let lastNotedCommit = ''

// Commits are the one moment a session reliably produced something worth keeping, so record them without the model.
async function noteCommit($: EngineInterface): Promise<void> {
  const ran = await $.process.run(['git', 'log', '-1', '--pretty=format:%h %s', '--shortstat'])
  if (ran.exitCode !== 0) return
  const lines = ran.stdout.split('\n').filter(line => line.trim())
  const subject = lines[0] ?? ''
  const hash = subject.split(' ')[0] ?? ''
  if (!hash || hash === lastNotedCommit) return
  lastNotedCommit = hash
  await cli($, ['note', 'commit ' + subject + (lines[1] ? ' (' + lines[1].trim() + ')' : ''), '--type', 'change'])
}

async function forget($: EngineInterface, name: string): Promise<void> {
  const answer = await $.ui.ask('Forget "' + name + '"? It stops appearing in searches.', ['Forget', 'Cancel'])
  if (answer !== 'Forget') return
  await cli($, ['forget', name])
  await update($, detailValue, () => null)
  await refresh($)
}

async function runSearch($: EngineInterface, query: string): Promise<void> {
  const text = query.trim()
  if (!text) {
    await update($, searchValue, () => null)
    return
  }
  const raw = await cli<{
    search: {
      entities: Array<{ name: string; entity_type: string; observations: Array<{ content: string }> }>
      entries: Array<{ title: string; type: string }>
    }
  }>($, ['snapshot', '--query', text])
  const found: SearchState = {
    query: text,
    entities: (raw?.search.entities ?? []).map(entity => ({
      name: entity.name,
      entity_type: entity.entity_type,
      facts: entity.observations.map(fact => fact.content),
    })),
    notes: (raw?.search.entries ?? []).map(entry => '[' + entry.type + '] ' + entry.title),
  }
  await update($, searchValue, () => found)
}

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function dots(importance: number): string {
  const n = Math.max(1, Math.min(5, Math.round(importance * 5)))
  return '●'.repeat(n) + '○'.repeat(5 - n)
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

function toastFor(tool: string, args: Record<string, unknown>): string | null {
  const text = (key: string) => String(args[key] ?? '')
  switch (tool) {
    case 'remember':
      return 'remembered ' + text('name') + ' (' + text('entity_type') + ')'
    case 'add_facts':
      return 'added ' + (Array.isArray(args.facts) ? args.facts.length : 1) + ' fact(s) to ' + text('entity_name')
    case 'correct_fact':
      return 'fact corrected'
    case 'link':
      return 'linked ' + text('from_name') + ' → ' + text('to_name')
    case 'forget':
      return 'forgot ' + text('name')
    case 'save_memory':
      return 'note saved: ' + text('title')
    case 'create_task_group':
      return 'task group created: ' + text('name')
    case 'complete_task':
      return 'task ' + text('task_id') + ' done'
    case 'fail_task':
      return 'task ' + text('task_id') + ' failed'
    default:
      return null
  }
}

export const register: Register = (on, options) => {
  const wantsToasts = options.toasts !== false
  const wantsNudge = options.nudge !== false
  const wantsBand = options.band !== false
  const wantsCommitNotes = options.commitNotes !== false
  const wantsApproval = options.approve !== false

  let edits = 0
  let commits = 0
  let saves = 0
  let pendingNudge: string | null = null

  on('session.start', async ($, e, next) => {
    background(refresh($))
    try {
      await $.command.register({ name: 'brain', description: 'Open the task and memory panel' })
      await $.command.register({ name: 'recall', description: 'Search project memory', argumentHint: '<keywords>' })
      await $.command.register({ name: 'remember', description: 'Save a note to project memory', argumentHint: '<text>' })
      await $.command.register({ name: 'worklog', description: 'Show time spent by you and the agent', argumentHint: '[today|week|last-week|month]' })
    } catch (error) {
      $.ui.log('task-runner: command registration skipped: ' + String(error))
    }
    return next(e)
  })

  on('command.run', { command: 'brain' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    background(refresh($))
    return {}
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /recall <keywords>' }
    const raw = await cli<{
      search: {
        entities: Array<{ name: string; entity_type: string; observations: Array<{ content: string }> }>
        entries: Array<{ title: string; type: string }>
      }
    }>($, ['snapshot', '--query', e.args])
    if (!raw) return { text: 'task-runner: memory is unavailable. Run `node ' + $.plugin.root + '/dist/cli.js doctor`.' }
    const lines = [
      ...raw.search.entities.map(
        entity =>
          entity.entity_type + ' ' + entity.name + ': ' + entity.observations.map(fact => fact.content).join('; '),
      ),
      ...raw.search.entries.map(entry => '[' + entry.type + '] ' + entry.title),
    ]
    return { text: lines.length ? lines.join('\n') : 'Nothing found for "' + e.args.trim() + '".' }
  })

  on('command.run', { command: 'worklog' }, async ($, e) => {
    const period = e.args.trim() || 'week'
    if (!['today', 'yesterday', 'week', 'last-week', 'month'].includes(period)) {
      return { text: 'Usage: /worklog [today|yesterday|week|last-week|month]' }
    }
    const text = await cliText($, ['worklog', '--' + period, '--detail'])
    return { text: text ?? 'task-runner: could not read the time report. Run `node ' + $.plugin.root + '/dist/cli.js doctor`.' }
  })

  on('command.run', { command: 'remember' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /remember <text>' }
    const saved = await cli($, ['note', e.args])
    background(refresh($))
    return { text: saved ? 'Saved to project memory.' : 'task-runner: could not save the note.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const mcp = MEMORY_TOOL.exec(tool)

    if (FILE_EDITS.has(tool)) {
      edits += 1
    } else if (tool === 'Bash' && /\bgit\s+commit\b/.test(String((e as { command?: unknown }).command ?? ''))) {
      const failed = ('deny' in ran && Boolean(ran.deny)) || Boolean((ran as { isError?: boolean }).isError)
      if (!failed) {
        commits += 1
        if (wantsCommitNotes) {
          background(
            noteCommit($).then(() => refresh($)),
          )
        }
      }
    } else if (mcp) {
      const name = mcp[1] ?? ''
      const failed = ('deny' in ran && Boolean(ran.deny)) || Boolean((ran as { isError?: boolean }).isError)
      if (!failed && SAVES_MEMORY.has(name)) {
        saves += 1
        edits = 0
        commits = 0
      }
      if (!failed && wantsToasts && WRITES.has(name)) {
        const message = toastFor(name, e as unknown as Record<string, unknown>)
        if (message) $.ui.toast('task-runner: ' + message)
      }
      background(refresh($))
    }
    return ran
  })

  on('tool.check', { tool: /^mcp__plugin_task-runner_task-runner__/ }, async ($, e, next) => {
    const decided = await next(e)
    const name = OWN_TOOL.exec(e.tool)?.[1] ?? ''
    if (!wantsApproval || decided.decision === 'deny') return decided
    if (PROMPT_FREE.has(name)) {
      return { decision: 'allow', reason: 'task-runner: local memory tool' }
    }
    return decided
  })

  on('turn.complete', async ($, e, next) => {
    background(refresh($))
    const isMainTurn = e.agentId === undefined && !e.isAborted
    const shouldNudge = wantsNudge && isMainTurn && saves === 0 && pendingNudge === null && (commits > 0 || edits >= 6)
    if (shouldNudge) {
      pendingNudge =
        '[task-runner] This session changed ' +
        edits +
        ' file(s)' +
        (commits ? ' and made ' + commits + ' commit(s)' : '') +
        ' without saving anything to memory. Before finishing, record durable decisions, pitfalls and conventions with remember, and what was done with save_memory.'
      $.ui.toast('task-runner: nothing saved to memory yet, reminding the agent')
      edits = 0
      commits = 0
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (pendingNudge === null) return next(e)
    const note = pendingNudge
    pendingNudge = null
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const snapshot = await read($, snapshotValue)
    const tab = await read($, tabValue)
    const detail = await read($, detailValue)
    const search = await read($, searchValue)
    const worklog = await read($, worklogValue)
    const width = Math.max(24, e.props.bodyColumns)

    const tabs = (
      <Box flexDirection="row" columnGap={1}>
        {TABS.map(item => (
          <Button
            key={'tab-' + item.id}
            label={item.label}
            variant={tab === item.id ? 'primary' : 'secondary'}
            onPress={async () => {
              await update($, tabValue, () => item.id)
              if (item.id === 'time') await loadWorklog($)
            }}
          />
        ))}
        <Button key="refresh" label="↻" onPress={() => refresh($)} />
      </Box>
    )

    if (!snapshot) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>Loading project memory…</Text>
        </Box>
      )
    }

    let body
    if (tab === 'tasks') {
      const group = snapshot.tasks
      body = !group ? (
        <Text dimColor>No task group yet. Multi-step work shows up here once the agent calls create_task_group.</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>
            {group.summary.task_group} {bar(group.summary.completed, group.summary.total, Math.min(20, width - 16))}{' '}
            {group.summary.completed}/{group.summary.total}
            {group.summary.failed ? ' · ' + group.summary.failed + ' failed' : ''}
          </Text>
          {group.items.map(item => (
            <Box flexDirection="column">
              <Text dimColor={item.status === 'completed' || item.status === 'pending'}>
                {GLYPH[item.status] ?? '?'} {item.id} {item.title}
              </Text>
              {item.error ? <Text color="red">    {item.error}</Text> : null}
            </Box>
          ))}
        </Box>
      )
    } else if (tab === 'notes') {
      body = snapshot.notes.length ? (
        <Box flexDirection="column">
          {snapshot.notes.map(note => (
            <Text>
              <Text dimColor>{day(note.created_at)} {note.type} </Text>
              {note.title}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>No notes yet. /remember &lt;text&gt; saves one.</Text>
      )
    } else if (tab === 'graph') {
      body = (
        <Box flexDirection="column">
          {detail ? (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text bold>
                {detail.name} <Text dimColor>({detail.type})</Text>
              </Text>
              {detail.summary ? <Text>{detail.summary}</Text> : null}
              {detail.facts.map(fact => (
                <Text>• {fact}</Text>
              ))}
              {detail.relations.map(relation => (
                <Text dimColor>↔ {relation}</Text>
              ))}
              <Box flexDirection="row" columnGap={1}>
                <Button key="close-detail" label="Close" onPress={() => update($, detailValue, () => null)} />
                <Button key="forget" label="Forget" onPress={() => forget($, detail.name)} />
              </Box>
            </Box>
          ) : null}
          {snapshot.entities.length === 0 ? (
            <Text dimColor>The graph is empty. The agent fills it with remember.</Text>
          ) : (
            snapshot.entities.map(entity => (
              <Button key={entity.id} plain onPress={() => openDetail($, entity.name)}>
                {dots(entity.importance)} {entity.name} <Text dimColor>{entity.entity_type}</Text>
              </Button>
            ))
          )}
        </Box>
      )
    } else if (tab === 'time') {
      const peak = Math.max(1, ...(worklog?.days ?? []).map(d => d.you_s + d.agent_s))
      body = !worklog ? (
        <Text dimColor>Reading the session transcripts… the first run can take a minute.</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>{worklog.label}</Text>
          <Text>
            You {hours(worklog.totals.you_s)} · agent {hours(worklog.totals.agent_s)} · wall {hours(worklog.totals.wall_s)}
          </Text>
          <Text dimColor>Agent time adds up across parallel sessions.</Text>
          {worklog.days.map(day => (
            <Text>
              <Text dimColor>{day.day.slice(5)} </Text>
              {bar(day.you_s + day.agent_s, peak, 16)} {hours(day.you_s)} / {hours(day.agent_s)}
            </Text>
          ))}
          {worklog.rows.map(row => (
            <Text>
              <Text bold>{row.label}</Text> <Text dimColor>{row.project} · {row.kind}</Text> you {hours(row.you_s)} · agent{' '}
              {hours(row.agent_s)}
            </Text>
          ))}
          <Text dimColor>/worklog prints the full report with notes and commits.</Text>
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          {Input ? (
            <Input
              key="query"
              label="Search"
              placeholder="keywords, any language"
              value={search?.query ?? ''}
              submitLabel="search"
              onSubmit={text => runSearch($, text)}
            />
          ) : (
            <Text dimColor>Type /recall &lt;keywords&gt; to search.</Text>
          )}
          {search && search.entities.length === 0 && search.notes.length === 0 ? (
            <Text dimColor>Nothing found.</Text>
          ) : null}
          {search?.entities.map(entity => (
            <Text>
              <Text bold>{entity.name}</Text> <Text dimColor>{entity.entity_type}</Text> {entity.facts.join('; ')}
            </Text>
          ))}
          {search?.notes.map(note => <Text dimColor>{note}</Text>)}
        </Box>
      )
    }

    const { stats } = snapshot
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
        <Text dimColor>
          {snapshot.project}
          {snapshot.branch ? ' @ ' + snapshot.branch : ''} · {stats.entities} entities · {stats.relations} relations ·{' '}
          {stats.entries} notes
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!wantsBand || e.props.hasSurvey) return next(e)
    const snapshot = await read($, snapshotValue)
    const group = snapshot?.tasks
    if (!group || group.summary.pending + group.summary.running === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const current = group.items.find(item => item.status === 'running') ?? group.items.find(item => item.status === 'pending')

    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>
          {group.summary.task_group} {bar(group.summary.completed, group.summary.total, 10)} {group.summary.completed}/
          {group.summary.total}
          {current ? ' · ' + (GLYPH[current.status] ?? '') + ' ' + current.title : ''}
        </Text>
        <Button
          key="open"
          label="Open"
          onPress={() => $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })}
        />
      </Box>
    )
  })
}
