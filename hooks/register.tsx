import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, RulesView, SearchState, SessionView, Snapshot, Tab, WorklogView } from '../types'

const PANE = 'brain'
const TITLE = 'Task Runner'

const snapshotValue = atom({ plugin: 'task-runner', key: 'snapshot' } as const, null)
const tabValue = atom({ plugin: 'task-runner', key: 'tab' } as const, 'session')
const detailValue = atom({ plugin: 'task-runner', key: 'detail' } as const, null)
const searchValue = atom({ plugin: 'task-runner', key: 'search' } as const, null)
const worklogValue = atom({ plugin: 'task-runner', key: 'worklog' } as const, null)
const rulesValue = atom({ plugin: 'task-runner', key: 'rules' } as const, null)
const sessionValue = atom({ plugin: 'task-runner', key: 'session' } as const, null)
const commitsValue = atom({ plugin: 'task-runner', key: 'commits' } as const, [])

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'session', label: 'Session' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'notes', label: 'Notes' },
  { id: 'graph', label: 'Graph' },
  { id: 'search', label: 'Search' },
  { id: 'time', label: 'Time' },
  { id: 'rules', label: 'Rules' },
]

const GLYPH: Record<string, string> = { completed: '✓', failed: '✗', running: '▶', pending: '·' }

const MEMORY_TOOL = /^mcp__(?:plugin_task-runner_)?task-runner__(\w+)$/
const WRITES = new Set([
  'remember', 'add_facts', 'correct_fact', 'link', 'forget', 'save_memory',
  'create_task_group', 'complete_task', 'fail_task', 'rules',
])
const SAVES_MEMORY = new Set(['remember', 'add_facts', 'correct_fact', 'link', 'save_memory'])
const FILE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Every tool only touches the local memory database; clear_tasks stays behind the normal rules.
const OWN_TOOL = /^mcp__plugin_task-runner_task-runner__(\w+)$/
const PROMPT_FREE = new Set([
  'set_context', 'list_projects', 'get_context', 'save_memory', 'remember', 'correct_fact', 'link', 'recall',
  'what_do_i_know', 'forget', 'graph_stats', 'create_task_group', 'get_next_task', 'complete_task', 'get_task_status',
  'rules', 'worklog',
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

async function loadRules($: EngineInterface): Promise<void> {
  const shown = await cliText($, ['rules', 'show', '--json'])
  const pending = await cliText($, ['rules', 'pending', '--json'])
  if (!shown) return
  try {
    const r = JSON.parse(shown) as { parts: RulesView['parts']; chars: number; source: string }
    const view: RulesView = {
      parts: r.parts,
      chars: r.chars,
      source: r.source,
      pending: pending ? (JSON.parse(pending) as RulesView['pending']) : [],
    }
    await update($, rulesValue, () => view)
  } catch {
    $.ui.log('task-runner: could not read the rules')
  }
}

let sessionLoadedAt = 0
let isLoadingSession = false

// Reads only this session's transcript, so it is cheap enough to run after every turn.
async function loadSession($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (isLoadingSession || (!force && now - sessionLoadedAt < 5000)) return
  isLoadingSession = true
  try {
    const view = await cli<SessionView>($, ['session', '--id', await $.session.id()])
    sessionLoadedAt = now
    if (view && Array.isArray(view.scopes)) await update($, sessionValue, () => view)
  } finally {
    isLoadingSession = false
  }
}

async function decide($: EngineInterface, action: 'approve' | 'reject', id: string): Promise<void> {
  await cliText($, ['rules', action, id])
  await loadRules($)
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
  await update($, commitsValue, list => [subject, ...list].slice(0, 20))
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

function clock(seconds: number): string {
  const d = new Date(seconds * 1000)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// One entry in the pane's list: what it draws and how many rows it takes, so the list can be paged.
type Line = { key: string; node: JSX.Element; rows: number }

const rowsFor = (text: string, width: number) => Math.max(1, Math.ceil(text.length / Math.max(10, width)))

// The pane draws its own window over a tab's list and keeps the tabs in view, so the wheel and the
// scroll keys move the list, not the pane. Per tab: the first line shown.
const offsets: Partial<Record<Tab, number>> = {}
let shownTab: Tab = 'session'
let pagingShown = false
// Desktop scrolls a pane's body natively and raises ui.scroll only when the body has room to move, so the
// window is drawn between two blank rows and held on the row under the top one. The terminal needs only the row below.
let restOffset = 0
let restedTab = ''
let lastStep = 1
let maxOffset = 0
const PAGE_STEP = 5

function moveList($: EngineInterface, step: number): void {
  const current = offsets[shownTab] ?? 0
  const next = Math.max(0, Math.min(maxOffset, current + step))
  if (next === current) return
  offsets[shownTab] = next
  $.ui.invalidate('ui.render')
}

// Puts the pane on its rest row: the tabs at the top, a row of room above and below for the wheel.
function toRest($: EngineInterface): void {
  background($.ui.scroll({ to: { key: 'pane-top' }, in: PANE, block: 'start' }))
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
    case 'rules':
      return text('action') === 'propose' ? 'the agent proposed a rule. Review it with /rules or in the Rules tab' : null
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
    background(loadSession($, true))
    try {
      await $.command.register({ name: 'brain', description: 'Open the task and memory panel' })
      await $.command.register({ name: 'recall', description: 'Search project memory', argumentHint: '<keywords>' })
      await $.command.register({ name: 'remember', description: 'Save a note to project memory', argumentHint: '<text>' })
      await $.command.register({ name: 'rules', description: 'Show your rules, or approve or reject a proposal', argumentHint: '[approve|reject <id>]' })
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

  on('command.run', { command: 'rules' }, async ($, e) => {
    const [action, id] = e.args.trim().split(/\s+/)
    if (action === 'approve' || action === 'reject') {
      if (!id) return { text: 'Usage: /rules ' + action + ' <id>' }
      const out = await cliText($, ['rules', action, id])
      background(loadRules($))
      return { text: out ?? 'task-runner: could not ' + action + ' ' + id }
    }
    const shown = await cliText($, ['rules', 'show'])
    const pending = await cliText($, ['rules', 'pending'])
    return { text: [shown ?? 'task-runner: rules are unavailable.', pending && !pending.startsWith('No proposals') ? '\nWaiting for your decision:\n' + pending : ''].join('') }
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
            noteCommit($).then(() => refresh($)).then(() => loadSession($, true)),
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
      if (SAVES_MEMORY.has(name)) background(loadSession($, true))
      if (name === 'rules') background(loadRules($))
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
    if (e.agentId === undefined) background(loadSession($, true))
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

  // The wheel, the arrows and the page keys move the list by lines; the pane itself stays on its rest row.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (pagingShown && restOffset && e.origin?.kind === 'plugin') return next({ ...e, offset: restOffset })
    if (!pagingShown || e.by === 0 || e.origin?.kind !== 'person') return next(e)
    const size = Math.abs(e.by)
    // The terminal: an arrow is one line, a page key a page. Desktop: a trackpad sends many small moves.
    const lines = restOffset === 0 ? (size >= 3 ? lastStep : 1) : Math.max(1, Math.round(size / 3))
    moveList($, Math.sign(e.by) * Math.min(lines, PAGE_STEP * 4))
    return next({ ...e, offset: restOffset })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const graphic = e.surface !== 'terminal'
    const snapshot = await read($, snapshotValue)
    const tab = await read($, tabValue)
    const detail = await read($, detailValue)
    const search = await read($, searchValue)
    const worklog = await read($, worklogValue)
    const rules = await read($, rulesValue)
    const session = await read($, sessionValue)
    const commits = await read($, commitsValue)
    const width = Math.max(24, e.props.bodyColumns)
    const fullHeight = e.props.scroll?.bodyRows || undefined
    const redraw = () => $.ui.invalidate('ui.render')
    shownTab = tab

    const select = async (id: Tab) => {
      await update($, tabValue, () => id)
      if (id === 'time') await loadWorklog($)
      if (id === 'rules') await loadRules($)
      if (id === 'session') await loadSession($)
    }

    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={0}>
        {TABS.map((item, i) =>
          graphic ? (
            <Button
              key={'tab-' + item.id}
              label={item.label}
              variant={tab === item.id ? 'primary' : 'secondary'}
              onPress={() => select(item.id)}
            />
          ) : (
            <Button key={'tab-' + item.id} plain hotkey={String(i + 1)} dimColor={tab !== item.id} onPress={() => select(item.id)}>
              {(tab === item.id ? '[' + item.label + ']' : item.label)}
            </Button>
          ),
        )}
        {graphic ? (
          <Button key="refresh" label="↻" onPress={() => Promise.all([refresh($), loadSession($, true)])} />
        ) : (
          <Button key="refresh" label="↻" plain hotkey="r" onPress={() => Promise.all([refresh($), loadSession($, true)])} />
        )}
      </Box>
    )

    const line = (key: string, node: JSX.Element, text = '', rows?: number): Line => ({
      key,
      node,
      rows: rows ?? (graphic ? rowsFor(text, width - 2) : 1),
    })
    const plain = (key: string, text: string, props: { dimColor?: boolean; bold?: boolean } = {}) =>
      line(key, <Text key={key} dimColor={props.dimColor} bold={props.bold} wrap="truncate-end">{text}</Text>, text)
    const wrapped = (key: string, text: string, props: { dimColor?: boolean; bold?: boolean } = {}) =>
      line(key, <Text key={key} dimColor={props.dimColor} bold={props.bold}>{text}</Text>, text, rowsFor(text, width - 2))

    let lines: Line[] = []
    let top: JSX.Element | null = null

    if (!snapshot) {
      lines = [plain('loading', 'Loading project memory…', { dimColor: true })]
    } else if (tab === 'session') {
      const s = session
      if (!s) {
        lines = [plain('session-loading', 'Reading this session…', { dimColor: true })]
      } else {
        lines.push(plain('s-head', 'This session' + (s.started_at ? ' · since ' + clock(s.started_at) : ''), { bold: true }))
        lines.push(plain('s-time', 'You ' + hours(s.you_s) + ' · agent ' + hours(s.agent_s) + ' · wall ' + hours(s.wall_s)))
        lines.push(
          plain('s-work', s.prompts + ' prompt(s) · ' + s.edits + ' file edit(s) · ' + commits.length + ' commit(s)', { dimColor: true }),
        )
        if (s.first_prompt) lines.push(plain('s-first', 'Started from: ' + s.first_prompt, { dimColor: true }))
        if (s.scopes.length > 1) {
          lines.push(plain('s-scopes', 'Worked in: ' + s.scopes.map(x => x.project_key + ' ' + hours(x.secs)).join(', '), { dimColor: true }))
        }
        const group = snapshot.tasks
        if (group && group.summary.pending + group.summary.running > 0) {
          lines.push(
            plain(
              's-tasks',
              group.summary.task_group + ' ' + bar(group.summary.completed, group.summary.total, 10) + ' ' + group.summary.completed + '/' + group.summary.total,
            ),
          )
        }
        const saved = s.entities.length + s.notes.length
        lines.push(plain('s-saved', saved ? 'Saved to memory this session (' + saved + ')' : 'Nothing saved to memory yet', { bold: true }))
        if (!saved) {
          lines.push(wrapped('s-saved-hint', 'The agent saves with remember and save_memory. /remember <text> adds a note.', { dimColor: true }))
        }
        for (const entity of s.entities) {
          const mark = entity.is_new ? '+ ' : '~ '
          const extra = entity.is_new ? '' : ' +' + entity.new_facts + ' fact(s)'
          lines.push(
            line(
              'se-' + entity.entity_type + '-' + entity.name,
              <Button key={'se-' + entity.entity_type + '-' + entity.name} plain onPress={() => select('graph').then(() => openDetail($, entity.name))}>
                {mark + entity.name} <Text dimColor>{entity.entity_type + extra}</Text>
              </Button>,
              mark + entity.name + entity.entity_type + extra,
              graphic ? 2 : 1,
            ),
          )
        }
        for (const note of s.notes) lines.push(plain('sn-' + note.id, clock(note.created_at) + ' [' + note.type + '] ' + note.title))
        if (commits.length) {
          lines.push(plain('s-commits', 'Commits', { bold: true }))
          commits.forEach((subject, i) => lines.push(plain('sc-' + i, subject, { dimColor: true })))
        }
        if (rules) {
          lines.push(
            plain(
              's-rules',
              'Rules: ' + rules.parts.length + ' section(s), ' + rules.chars + ' chars' + (rules.pending.length ? ' · ' + rules.pending.length + ' to review' : ''),
              { dimColor: true },
            ),
          )
        }
      }
    } else if (tab === 'tasks') {
      const group = snapshot.tasks
      if (!group) {
        lines = [wrapped('no-tasks', 'No task group yet. Multi-step work shows up here once the agent calls create_task_group.', { dimColor: true })]
      } else {
        top = (
          <Text key="group-head" bold wrap="truncate-end">
            {group.summary.task_group} {bar(group.summary.completed, group.summary.total, Math.min(20, width - 16))}{' '}
            {group.summary.completed}/{group.summary.total}
            {group.summary.failed ? ' · ' + group.summary.failed + ' failed' : ''}
          </Text>
        )
        for (const item of group.items) {
          lines.push(
            plain('task-' + item.id, (GLYPH[item.status] ?? '?') + ' ' + item.id + ' ' + item.title, {
              dimColor: item.status === 'completed' || item.status === 'pending',
            }),
          )
          if (item.error) lines.push(line('task-err-' + item.id, <Text key={'task-err-' + item.id} color="red">{'    ' + item.error}</Text>, item.error))
        }
      }
    } else if (tab === 'notes') {
      lines = snapshot.notes.length
        ? snapshot.notes.map(note =>
            line(
              'note-' + note.id,
              <Text key={'note-' + note.id} wrap="truncate-end">
                <Text dimColor>{day(note.created_at)} {note.type} </Text>
                {note.title}
              </Text>,
              note.title + note.type + '0000-00-00 ',
            ),
          )
        : [plain('no-notes', 'No notes yet. /remember <text> saves one.', { dimColor: true })]
    } else if (tab === 'graph') {
      if (detail) {
        top = (
          <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
            <Text bold wrap="truncate-end">
              {detail.name} <Text dimColor>({detail.type})</Text>
            </Text>
            {detail.summary ? <Text wrap="truncate-end">{detail.summary}</Text> : null}
            {detail.facts.slice(0, 6).map(fact => (
              <Text wrap="truncate-end">• {fact}</Text>
            ))}
            {detail.facts.length > 6 ? <Text dimColor>+{detail.facts.length - 6} more fact(s)</Text> : null}
            {detail.relations.slice(0, 4).map(relation => (
              <Text dimColor wrap="truncate-end">↔ {relation}</Text>
            ))}
            <Box flexDirection="row" columnGap={1}>
              <Button key="close-detail" label="Close" onPress={() => update($, detailValue, () => null)} />
              <Button key="forget" label="Forget" onPress={() => forget($, detail.name)} />
            </Box>
          </Box>
        )
      }
      lines = snapshot.entities.length
        ? snapshot.entities.map(entity =>
            line(
              entity.id,
              <Button key={entity.id} plain onPress={() => openDetail($, entity.name)}>
                {dots(entity.importance)} {entity.name} <Text dimColor>{entity.entity_type}</Text>
              </Button>,
              entity.name + entity.entity_type + '●●●●● ',
              graphic ? 2 : 1,
            ),
          )
        : [plain('graph-empty', 'The graph is empty. The agent fills it with remember.', { dimColor: true })]
    } else if (tab === 'rules') {
      if (!rules) {
        lines = [plain('rules-loading', 'Reading your rules…', { dimColor: true })]
      } else {
        lines.push(plain('rules-head', 'Rules for this session (' + rules.chars + ' characters)', { bold: true }))
        lines.push(plain('rules-source', 'from ' + rules.source, { dimColor: true }))
        if (rules.parts.length === 0) {
          lines.push(wrapped('rules-none', 'No rules yet. Add some with `task-runner-mcp rules set "..."` or on the web page.', { dimColor: true }))
        }
        rules.parts.forEach((part, i) =>
          lines.push(
            line(
              'part-' + i,
              <Text key={'part-' + i} wrap="truncate-end">
                · {part.label} <Text dimColor>{part.chars} chars</Text>
              </Text>,
              part.label,
            ),
          ),
        )
        lines.push(plain('pending-head', rules.pending.length ? 'Waiting for your decision' : 'No proposals waiting', { bold: true }))
        for (const proposal of rules.pending) {
          const text = proposal.text + (proposal.reason ? ' why: ' + proposal.reason : '')
          lines.push(
            line(
              'proposal-' + proposal.id,
              <Box key={'proposal-' + proposal.id} flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="truncate-end">
                  {proposal.where} <Text dimColor>{proposal.mode} by {proposal.author}</Text>
                </Text>
                {proposal.reason ? <Text dimColor wrap="truncate-end">why: {proposal.reason}</Text> : null}
                <Text>{proposal.text}</Text>
                <Box flexDirection="row" columnGap={1}>
                  <Button key={'approve-' + proposal.id} label="Approve" variant="primary" onPress={() => decide($, 'approve', proposal.id)} />
                  <Button key={'reject-' + proposal.id} label="Reject" onPress={() => decide($, 'reject', proposal.id)} />
                </Box>
              </Box>,
              text,
              rowsFor(proposal.text, width - 4) * (graphic ? 1.5 : 1) + (proposal.reason ? 1 : 0) + (graphic ? 6 : 4),
            ),
          )
        }
      }
    } else if (tab === 'time') {
      if (!worklog) {
        lines = [wrapped('time-loading', 'Reading the session transcripts… the first run can take a minute.', { dimColor: true })]
      } else {
        const peak = Math.max(1, ...worklog.days.map(d => d.you_s + d.agent_s))
        lines.push(plain('time-label', worklog.label, { bold: true }))
        lines.push(plain('time-total', 'You ' + hours(worklog.totals.you_s) + ' · agent ' + hours(worklog.totals.agent_s) + ' · wall ' + hours(worklog.totals.wall_s)))
        lines.push(plain('time-note', 'Agent time adds up across parallel sessions.', { dimColor: true }))
        for (const d of worklog.days) {
          lines.push(
            line(
              'day-' + d.day,
              <Text key={'day-' + d.day} wrap="truncate-end">
                <Text dimColor>{d.day.slice(5)} </Text>
                {bar(d.you_s + d.agent_s, peak, 16)} {hours(d.you_s)} / {hours(d.agent_s)}
              </Text>,
            ),
          )
        }
        worklog.rows.forEach((row, i) =>
          lines.push(
            line(
              'row-' + i,
              <Text key={'row-' + i} wrap="truncate-end">
                <Text bold>{row.label}</Text> <Text dimColor>{row.project} · {row.kind}</Text> you {hours(row.you_s)} · agent{' '}
                {hours(row.agent_s)}
              </Text>,
              row.label + row.project + row.kind + ' you 00h 00m · agent 00h 00m',
            ),
          ),
        )
        lines.push(plain('time-more', '/worklog prints the full report with notes and commits.', { dimColor: true }))
      }
    } else {
      top = Input ? (
        <Input
          key="query"
          label="Search"
          placeholder="keywords, any language"
          value={search?.query ?? ''}
          submitLabel="search"
          onSubmit={text => runSearch($, text)}
        />
      ) : (
        <Text key="query-hint" dimColor>Type /recall &lt;keywords&gt; to search.</Text>
      )
      if (search && search.entities.length === 0 && search.notes.length === 0) lines.push(plain('nothing', 'Nothing found.', { dimColor: true }))
      for (const entity of search?.entities ?? []) {
        const text = entity.name + ' ' + entity.entity_type + ' ' + entity.facts.join('; ')
        lines.push(
          line(
            'hit-' + entity.entity_type + '-' + entity.name,
            <Text key={'hit-' + entity.entity_type + '-' + entity.name}>
              <Text bold>{entity.name}</Text> <Text dimColor>{entity.entity_type}</Text> {entity.facts.join('; ')}
            </Text>,
            text,
            rowsFor(text, width - 2),
          ),
        )
      }
      ;(search?.notes ?? []).forEach((note, i) => lines.push(plain('hit-note-' + i, note, { dimColor: true })))
    }

    const footerText = snapshot
      ? snapshot.project + (snapshot.branch ? ' @ ' + snapshot.branch : '') + ' · ' + snapshot.stats.entities + ' entities · ' +
        snapshot.stats.relations + ' relations · ' + snapshot.stats.entries + ' notes'
      : ''

    // The window: what fits between the fixed rows, counted in the pane's rows. Desktop text is taller than a row.
    const unit = graphic ? 1.5 : 1
    const fixedRows = graphic ? 9 + (top ? 5 : 0) : 4 + (width < 60 ? 1 : 0) + (top ? (tab === 'graph' ? 10 : 2) : 0)
    const room = fullHeight ? Math.max(3, (fullHeight - fixedRows) / unit) : Infinity
    const fits = (from: number) => {
      let used = 0
      let end = from
      while (end < lines.length && (used + lines[end]!.rows <= room || end === from)) used += lines[end++]!.rows
      return end
    }
    let fromEnd = lines.length
    for (let used = 0; fromEnd > 0 && used + lines[fromEnd - 1]!.rows <= room; ) used += lines[--fromEnd]!.rows
    maxOffset = Math.max(0, fromEnd)
    const start = Math.min(offsets[tab] ?? 0, maxOffset)
    offsets[tab] = start
    const end = fits(start)
    lastStep = Math.max(1, end - start - 1)
    const above = start
    const below = lines.length - end

    pagingShown = !!fullHeight
    restOffset = fullHeight && graphic ? 1 : 0
    if (fullHeight && e.surface === 'desktop' && restedTab !== tab) {
      restedTab = tab
      // Desktop may not have laid the pane out yet when the first try goes, so a few more follow.
      for (const ms of [60, 300, 800]) $.clock.after(ms, () => toRest($))
    }

    const pager =
      above || below ? (
        <Box key="pager" flexDirection="row" columnGap={2} flexShrink={0}>
          {above ? <Button key="page-up" label={'↑ ' + above + ' more'} plain dimColor hotkey={graphic ? undefined : 'k'} onPress={() => moveList($, -Math.max(1, end - start - 1))} /> : null}
          {below ? <Button key="page-down" label={'↓ ' + below + ' more'} plain dimColor hotkey={graphic ? undefined : 'j'} onPress={() => moveList($, Math.max(1, end - start - 1))} /> : null}
        </Box>
      ) : null

    const body = (
      <Box key="pane-top" flexDirection="column" height={fullHeight} overflow="hidden" rowGap={graphic ? 1 : 0}>
        {tabs}
        {top}
        <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          {lines.slice(start, end).map(l => l.node)}
        </Box>
        {pager}
        <Text key="footer" dimColor wrap="truncate-end">{footerText}</Text>
      </Box>
    )
    if (!fullHeight) return body
    // The rows out of view only give the wheel and the scroll keys room to raise ui.scroll.
    return (
      <Box flexDirection="column">
        {graphic ? <Box key="scroll-row-top" height={1} /> : null}
        {body}
        <Box key="scroll-row" height={1} />
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
