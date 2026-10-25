import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, RulesView, SearchState, SessionView, Snapshot, Tab, TastePreference, WorklogView } from '../types'

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
const tasteValue = atom({ plugin: 'task-runner', key: 'taste' } as const, null)
// null: the plugin setting decides; 'on' or 'off': the person's choice for this session.
const tasteModeValue = atom({ plugin: 'task-runner', key: 'tasteMode' } as const, null)
// Preferences learned since the last prompt, told to the agent with the next one.
const tasteNoteValue = atom({ plugin: 'task-runner', key: 'tasteNote' } as const, [])

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'session', label: 'Session' },
  { id: 'taste', label: 'Taste' },
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
  'create_task_group', 'complete_task', 'fail_task', 'rules', 'taste',
])
const SAVES_MEMORY = new Set(['remember', 'add_facts', 'correct_fact', 'link', 'save_memory'])
const FILE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Every tool only touches the local memory database; clear_tasks stays behind the normal rules.
const OWN_TOOL = /^mcp__plugin_task-runner_task-runner__(\w+)$/
const PROMPT_FREE = new Set([
  'set_context', 'list_projects', 'get_context', 'save_memory', 'remember', 'correct_fact', 'link', 'recall',
  'what_do_i_know', 'forget', 'graph_stats', 'create_task_group', 'get_next_task', 'complete_task', 'get_task_status',
  'rules', 'worklog', 'taste',
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

// ─── Taste: learned from what the person says, kept in memory, no approval step ───

// Words that carry a directive, a correction or a preference. Turkish stems match their suffixed forms.
const TASTE_SIGNAL = new RegExp(
  [
    '\\b(always|never|don\'t|do not|stop|instead|prefer|from now on|i want|i don\'t want|wrong|not like that|too (long|short|much|many|verbose))\\b',
    'hep |her zaman|asla|hiçbir zaman|bundan sonra|artık|yapma|etme|istemiyorum|istiyorum|olmasın|olsun|tercih|yerine|yanlış|hayır|öyle değil|böyle değil|çok uzun|çok kısa|fazla|gerek yok|kullanma|şöyle yap|böyle yap|unutma|dikkat et',
  ].join('|'),
  'i',
)
const TASTE_MAX_PROMPT = 2000

async function loadTaste($: EngineInterface): Promise<void> {
  const raw = await cli<{ preferences: TastePreference[] }>($, ['taste', 'list', '--json'])
  if (raw && Array.isArray(raw.preferences)) await update($, tasteValue, () => raw.preferences)
}

async function tasteIsOn($: EngineInterface, byDefault: boolean): Promise<boolean> {
  const mode = await read($, tasteModeValue)
  return mode === null ? byDefault : mode === 'on'
}

function tastePrompt(known: TastePreference[], messages: string[] | null): string {
  return [
    '[task-runner taste] This is a background check, not a turn: do not answer the user and do not continue the task.',
    messages
      ? 'Read the user message(s) quoted below.'
      : 'Read every message the user wrote in this conversation, oldest first, including the ones a compaction summarised.',
    'Find lasting preferences: how they want things done, given as a directive, a correction, a rejection, a preference or an approval with a reason.',
    'Skip one-off task details (this file, this value, today) unless they show a general wish. Generalise one step: from "this menu" to "menus", not to "everything".',
    'Never record secrets, addresses, keys or people\'s names.',
    'scope: global for how they work or talk everywhere, org for every repository of this organization, project for this codebase only.',
    'Known preferences (id | scope | area | rule):',
    known.length ? known.map(k => k.id + ' | ' + k.scope + ' | ' + k.area + ' | ' + k.rule).join('\n') : '(none)',
    'For a message about a known preference use its id: reinforce (said again), refine (adjusted), replace (now wants something different on that point), drop (takes it back). Otherwise new.',
    'Reply with JSON only: {"items":[{"action":"new","scope":"global","area":"replies","rule":"Reply in the language the user writes in."}]}. Write each rule as one short imperative sentence in English. Reply {"items":[]} when nothing lasting was said.',
    ...(messages ? ['Messages:', ...messages.map(m => '<<<\n' + m + '\n>>>')] : []),
  ].join('\n')
}

// One fork per check: the session's own prefix comes from the cache, the main context gets nothing until it learned something.
async function learnTaste($: EngineInterface, messages: string[] | null, announce: boolean): Promise<number> {
  const known = (await read($, tasteValue)) ?? []
  const reply = await $.model.fork({ prompt: tastePrompt(known, messages) })
  if (!reply.isAnswered) return 0
  const json = /\{[\s\S]*\}/.exec(reply.text)?.[0]
  if (!json) return 0
  let items: unknown
  try {
    items = (JSON.parse(json) as { items?: unknown }).items
  } catch {
    return 0
  }
  if (!Array.isArray(items) || items.length === 0) return 0
  const out = await cli<{ learned: Array<{ action: string; rule: string }> }>($, [
    'taste', 'learn', '--data', JSON.stringify({ items: items.slice(0, 20), source: messages ? 'prompt' : 'backfill' }),
  ])
  const learned = out?.learned ?? []
  if (learned.length === 0) return 0
  await update($, tasteNoteValue, notes => [...notes, ...learned.map(l => (l.action === 'drop' ? 'no longer: ' : '') + l.rule)].slice(-10))
  await loadTaste($)
  if (announce) {
    const first = learned[0]!
    $.ui.toast('task-runner: ' + (learned.length === 1 ? (first.action === 'new' ? 'learned: ' : first.action + ': ') + first.rule : 'learned ' + learned.length + ' preference(s)'))
  }
  return learned.length
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

// ─── Look ───
// Colours that read on light and dark desktop themes: Claude's orange for you, a calm blue for the agent,
// translucent greys for cards.
const YOU = '#d97757'
const AGENT = '#7c8cf8'
const CARD = '#8e8e9314'
const CARD_EDGE = '#8e8e9333'
const CHIP = '#8e8e9326'
const MUTED = '#8e8e93'
const TYPE_COLOR: Record<string, string> = {
  decision: '#7c8cf8',
  pitfall: '#e5534b',
  convention: '#3fb950',
  pattern: '#d29922',
  preference: '#d97757',
  tool: '#39c5cf',
  concept: '#a371f7',
  file: '#8e8e93',
}
const STATUS_COLOR = { completed: '#3fb950', failed: '#e5534b', running: '#d29922', pending: '#8e8e93' } as Record<string, string> & { completed: string; failed: string; running: string; pending: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A rounded track with two parts side by side: you and the agent, or done and the rest.
function splitBarSvg(parts: Array<{ value: number; color: string }>, width: number, height = 8): string {
  const total = Math.max(1, parts.reduce((n, p) => n + p.value, 0))
  let x = 0
  const rects = parts
    .filter(p => p.value > 0)
    .map(p => {
      const w = Math.max(2, (p.value / total) * width)
      const r = '<rect x="' + x.toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + height + '" fill="' + p.color + '"/>'
      x += w
      return r
    })
    .join('')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
    '<clipPath id="c"><rect width="' + width + '" height="' + height + '" rx="' + height / 2 + '"/></clipPath>' +
    '<g clip-path="url(#c)"><rect width="' + width + '" height="' + height + '" fill="' + CHIP + '"/>' + rects + '</g></svg>'
  )
}

// One stacked bar per day: you at the bottom, the agent on top, the day under it.
function weekSvg(days: Array<{ day: string; you_s: number; agent_s: number }>, width: number, height = 120): string {
  const n = Math.max(1, days.length)
  const peak = Math.max(1, ...days.map(d => d.you_s + d.agent_s))
  const slot = width / n
  const bar = Math.min(28, slot * 0.6)
  const chart = height - 18
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
  const cols = days
    .map((d, i) => {
      const x = i * slot + (slot - bar) / 2
      const hy = (d.you_s / peak) * chart
      const ha = (d.agent_s / peak) * chart
      const label = names[new Date(d.day + 'T12:00:00').getDay()] ?? d.day.slice(5)
      return (
        '<rect x="' + x.toFixed(1) + '" y="' + (chart - hy - ha).toFixed(1) + '" width="' + bar.toFixed(1) + '" height="' + Math.max(0, ha).toFixed(1) + '" rx="3" fill="' + AGENT + '"/>' +
        '<rect x="' + x.toFixed(1) + '" y="' + (chart - hy).toFixed(1) + '" width="' + bar.toFixed(1) + '" height="' + Math.max(0, hy).toFixed(1) + '" rx="3" fill="' + YOU + '"/>' +
        '<text x="' + (x + bar / 2).toFixed(1) + '" y="' + (height - 4) + '" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="' + MUTED + '">' + esc(label) + '</text>'
      )
    })
    .join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + cols + '</svg>'
}

// Pixels to the pane's rows on a desktop, for paging. A row is about 15 CSS pixels there.
const pxRows = (px: number) => px / 15

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
  const tasteByDefault = options.taste !== false
  // The person's messages of the running turn that look like they carry a preference.
  let tasteCandidates: string[] = []

  let edits = 0
  let commits = 0
  let saves = 0
  let pendingNudge: string | null = null

  on('session.start', async ($, e, next) => {
    background(refresh($))
    background(loadSession($, true))
    background(loadTaste($))
    try {
      await $.command.register({ name: 'brain', description: 'Open the task and memory panel' })
      await $.command.register({ name: 'recall', description: 'Search project memory', argumentHint: '<keywords>' })
      await $.command.register({ name: 'remember', description: 'Save a note to project memory', argumentHint: '<text>' })
      await $.command.register({ name: 'rules', description: 'Show your rules, or approve or reject a proposal', argumentHint: '[approve|reject <id>]' })
      await $.command.register({ name: 'worklog', description: 'Show time spent by you and the agent', argumentHint: '[today|week|last-week|month]' })
      await $.command.register({ name: 'taste', description: 'What the agent learned about how you want things; on or off for this session', argumentHint: '[on|off|forget <id>]' })
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

  on('command.run', { command: 'taste' }, async ($, e) => {
    const [action, id] = e.args.trim().split(/\s+/)
    if (action === 'off') {
      await update($, tasteModeValue, () => 'off')
      tasteCandidates = []
      return { text: 'Taste learning is off for this session. What was learned stays and is still followed.' }
    }
    if (action === 'on') {
      await update($, tasteModeValue, () => 'on')
      await loadTaste($)
      // Turned on in a session that already ran: read what was said so far, once.
      const count = await learnTaste($, null, false)
      return { text: 'Taste learning is on for this session.' + (count ? ' From the messages so far: ' + count + ' preference(s) learned or updated.' : '') }
    }
    if (action === 'forget') {
      if (!id) return { text: 'Usage: /taste forget <id>' }
      const out = await cliText($, ['taste', 'forget', id])
      await loadTaste($)
      return { text: out ? 'Forgotten.' : 'task-runner: no preference ' + id }
    }
    const list = await cliText($, ['taste', 'list'])
    const learning = await tasteIsOn($, tasteByDefault)
    return { text: (list ?? 'task-runner: preferences are unavailable.') + '\n\nLearning is ' + (learning ? 'on' : 'off') + ' in this session (/taste ' + (learning ? 'off' : 'on') + ').' }
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
    if (e.agentId === undefined && !e.isAborted && tasteCandidates.length) {
      const messages = tasteCandidates
      tasteCandidates = []
      background(learnTaste($, messages, wantsToasts))
    }
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
    const context = [...(e.context ?? [])]
    if (pendingNudge !== null) {
      context.push(pendingNudge)
      pendingNudge = null
    }
    const text = e.text.trim()
    if (text && !text.startsWith('/') && text.length >= 8 && TASTE_SIGNAL.test(text) && (await tasteIsOn($, tasteByDefault))) {
      tasteCandidates.push(text.slice(0, TASTE_MAX_PROMPT))
    }
    const learned = await read($, tasteNoteValue)
    if (learned.length) {
      context.push('[task-runner] Learned from the user and kept for every session (follow from now on):\n' + learned.map(l => '- ' + l).join('\n'))
      await update($, tasteNoteValue, () => [])
    }
    return context.length === (e.context ?? []).length ? next(e) : next({ ...e, context })
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
    // resolve hands over every element on every surface; the terminal cannot draw an SVG.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const graphic = e.surface !== 'terminal'
    const snapshot = await read($, snapshotValue)
    const tab = await read($, tabValue)
    const detail = await read($, detailValue)
    const search = await read($, searchValue)
    const worklog = await read($, worklogValue)
    const rules = await read($, rulesValue)
    const session = await read($, sessionValue)
    const commits = await read($, commitsValue)
    const taste = await read($, tasteValue)
    const tasteOn = await tasteIsOn($, tasteByDefault)
    const width = Math.max(24, e.props.bodyColumns)
    // Desktop columns are narrower than its pixels; this is the drawing width the charts get.
    const chartWidth = Math.max(160, Math.min(560, width * 7 - 40))
    const fullHeight = e.props.scroll?.bodyRows || undefined
    shownTab = tab

    const select = async (id: Tab) => {
      await update($, tabValue, () => id)
      if (id === 'time') await loadWorklog($)
      if (id === 'rules') await loadRules($)
      if (id === 'session') await loadSession($)
      if (id === 'taste') await loadTaste($)
    }
    const reload = () => Promise.all([refresh($), loadSession($, true), loadTaste($)])

    // ── small pieces ──
    const chip = (key: string, text: string, color?: string) =>
      graphic ? (
        <Text key={key} size="caption" color={color} backgroundColor={CHIP}>{' ' + text + ' '}</Text>
      ) : (
        <Text key={key} color={color} dimColor={!color}>{text}</Text>
      )
    const section = (key: string, title: string, count?: number): Line =>
      line(
        key,
        <Box key={key} flexDirection="row" columnGap={1} alignItems="center" marginTop={graphic ? 'sm' : 0}>
          {graphic ? (
            <Text size="footnote" weight="semibold" dimColor>{title.toUpperCase()}</Text>
          ) : (
            <Text bold color="claude">{title}</Text>
          )}
          {count !== undefined ? <Text dimColor size="caption">{String(count)}</Text> : null}
        </Box>,
        graphic ? 2.2 : 1,
      )
    const bar = (key: string, parts: Array<{ value: number; color: string }>, w = chartWidth) =>
      Svg ? (
        <Svg key={key} alt="progress" width={w} height={8} source={splitBarSvg(parts, w)} />
      ) : (
        <Text key={key}>
          {parts.map((p, i) => {
            const total = Math.max(1, parts.reduce((n, q) => n + q.value, 0))
            const cells = Math.round((p.value / total) * 20)
            return <Text key={key + '-' + i} color={p.color}>{(i === parts.length - 1 ? '░' : '█').repeat(cells)}</Text>
          })}
        </Text>
      )
    function line(key: string, node: JSX.Element, rows: number): Line {
      return { key, node, rows }
    }
    const textRows = (text: string, extra = 0) => (graphic ? rowsFor(text, width - 6) * 1.45 + extra : rowsFor(text, width - 2))
    // A row of the list: an optional coloured mark, the text, a quiet note at the end.
    const row = (key: string, text: string, opts: { mark?: string; markColor?: string; note?: string; dim?: boolean; onPress?: () => unknown } = {}): Line => {
      const body = (
        <Text wrap="truncate-end" dimColor={opts.dim}>
          {opts.mark ? <Text color={opts.markColor}>{opts.mark + ' '}</Text> : null}
          {text}
          {opts.note ? <Text dimColor size="caption">{'  ' + opts.note}</Text> : null}
        </Text>
      )
      return line(
        key,
        opts.onPress ? (
          <Button key={key} plain onPress={opts.onPress}>
            {opts.mark ? <Text color={opts.markColor}>{opts.mark + ' '}</Text> : ''}
            {text}
            {opts.note ? <Text dimColor>{'  ' + opts.note}</Text> : ''}
          </Button>
        ) : (
          <Box key={key}>{body}</Box>
        ),
        graphic ? (opts.onPress ? 2.1 : 1.6) : 1,
      )
    }
    const wrapped = (key: string, text: string, dim = true): Line =>
      line(key, <Text key={key} dimColor={dim}>{text}</Text>, textRows(text))
    const card = (key: string, children: JSX.Element[], rows: number): Line =>
      line(
        key,
        graphic ? (
          <Box key={key} flexDirection="column" rowGap="xs" backgroundColor={CARD} borderStyle="round" borderColor={CARD_EDGE} padding="sm">
            {children}
          </Box>
        ) : (
          <Box key={key} flexDirection="column" borderStyle="round" paddingX={1}>{children}</Box>
        ),
        graphic ? rows * 1.45 + 2.5 : rows + 2,
      )
    const stat = (key: string, label: string, value: string, color: string) =>
      graphic ? (
        <Box key={key} flexDirection="column" flexGrow={1} backgroundColor={CARD} borderStyle="round" borderColor={CARD_EDGE} paddingX="sm" paddingY="xs">
          <Text size="caption" dimColor>{label}</Text>
          <Text size="title" weight="semibold" color={color}>{value}</Text>
        </Box>
      ) : (
        <Text key={key}>
          <Text color={color} bold>{value}</Text> <Text dimColor>{label}</Text>
        </Text>
      )

    // ── tab content ──
    let lines: Line[] = []
    let top: JSX.Element | null = null
    let topRows = 0

    if (!snapshot) {
      lines = [wrapped('loading', 'Loading project memory…')]
    } else if (tab === 'session') {
      const s = session
      if (!s) {
        lines = [wrapped('session-loading', 'Reading this session…')]
      } else {
        top = (
          <Box key="s-top" flexDirection="column" rowGap={graphic ? 'sm' : 0} flexShrink={0}>
            <Box flexDirection="row" columnGap={graphic ? 'sm' : 2} flexWrap="wrap">
              {stat('st-you', 'You', hours(s.you_s), YOU)}
              {stat('st-agent', 'Agent', hours(s.agent_s), AGENT)}
              {stat('st-wall', 'Wall clock', hours(s.wall_s), graphic ? 'text' : 'text')}
            </Box>
            {bar('s-split', [{ value: s.you_s, color: YOU }, { value: s.agent_s, color: AGENT }])}
            <Text key="s-work" dimColor wrap="truncate-end" size="caption">
              {(s.started_at ? 'since ' + clock(s.started_at) + ' · ' : '') + s.prompts + ' prompt(s) · ' + s.edits + ' file edit(s) · ' + commits.length + ' commit(s)'}
            </Text>
            {graphic ? (
              <Text key="s-legend" size="caption" dimColor>
                <Text color={YOU}>● </Text>you <Text color={AGENT}>  ● </Text>agent
              </Text>
            ) : null}
          </Box>
        )
        topRows = graphic ? 9.5 : 4
        if (s.first_prompt) {
          lines.push(section('s-first-head', 'Started from'))
          lines.push(line('s-first', <Text key="s-first" italic dimColor wrap="truncate-end">{'“' + s.first_prompt + '”'}</Text>, graphic ? 1.6 : 1))
        }
        if (s.scopes.length > 1) {
          lines.push(section('s-scopes-head', 'Worked in', s.scopes.length))
          const most = Math.max(1, ...s.scopes.map(x => x.secs))
          for (const x of s.scopes) {
            lines.push(
              line(
                'sw-' + x.project_key,
                <Box key={'sw-' + x.project_key} flexDirection="row" columnGap={1} alignItems="center">
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">{x.project_key}</Text>
                  </Box>
                  {bar('swb-' + x.project_key, [{ value: x.secs, color: YOU }, { value: most - x.secs, color: 'transparent' }], 80)}
                  <Text dimColor size="caption">{hours(x.secs)}</Text>
                </Box>,
                graphic ? 1.6 : 1,
              ),
            )
          }
        }
        const group = snapshot.tasks
        if (group && group.summary.pending + group.summary.running > 0) {
          lines.push(section('s-tasks-head', 'Task group'))
          lines.push(row('s-tasks', group.summary.task_group + '  ' + group.summary.completed + '/' + group.summary.total, { mark: '▶', markColor: STATUS_COLOR.running, onPress: () => select('tasks') }))
        }
        const saved = s.entities.length + s.notes.length
        lines.push(section('s-saved', saved ? 'Saved to memory this session (' + saved + ')' : 'Nothing saved to memory yet'))
        if (!saved) lines.push(wrapped('s-saved-hint', 'The agent saves with remember and save_memory. /remember <text> adds a note.'))
        for (const entity of s.entities) {
          lines.push(
            row('se-' + entity.entity_type + '-' + entity.name, entity.name, {
              mark: entity.is_new ? '＋' : '↻',
              markColor: TYPE_COLOR[entity.entity_type] ?? MUTED,
              note: entity.entity_type + (entity.is_new ? '' : ' · +' + entity.new_facts + ' fact(s)'),
              onPress: () => select('graph').then(() => openDetail($, entity.name)),
            }),
          )
        }
        for (const note of s.notes) {
          lines.push(row('sn-' + note.id, note.title, { mark: note.type === 'change' ? '⎇' : '✎', markColor: MUTED, note: clock(note.created_at) + ' · ' + note.type }))
        }
        if (commits.length) {
          lines.push(section('s-commits', 'Commits', commits.length))
          commits.forEach((subject, i) => {
            const [hash, ...rest] = subject.split(' ')
            lines.push(
              line(
                'sc-' + i,
                <Text key={'sc-' + i} wrap="truncate-end">
                  <Text color={AGENT} mono>{hash + ' '}</Text>
                  {rest.join(' ')}
                </Text>,
                graphic ? 1.6 : 1,
              ),
            )
          })
        }
        lines.push(section('s-taste-head', 'Taste'))
        lines.push(
          row('s-taste', (tasteOn ? 'Learning' : 'Off') + ' · ' + (taste?.length ?? 0) + ' preference(s) followed', {
            mark: tasteOn ? '●' : '○',
            markColor: tasteOn ? '#3fb950' : MUTED,
            onPress: () => select('taste'),
          }),
        )
        if (rules) {
          lines.push(
            row('s-rules', rules.parts.length + ' rule section(s), ' + rules.chars + ' chars' + (rules.pending.length ? ' · ' + rules.pending.length + ' to review' : ''), {
              mark: '§',
              markColor: rules.pending.length ? STATUS_COLOR.running : MUTED,
              onPress: () => select('rules'),
            }),
          )
        }
      }
    } else if (tab === 'taste') {
      top = (
        <Box key="taste-head" flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text weight="semibold" bold>{tasteOn ? 'Learning from what you say' : 'Learning is off in this session'}</Text>
          </Box>
          <Button
            key="taste-toggle"
            label={tasteOn ? 'Turn off' : 'Turn on'}
            onPress={async () => {
              await update($, tasteModeValue, () => (tasteOn ? 'off' : 'on'))
              if (!tasteOn) background(learnTaste($, null, true))
            }}
          />
        </Box>
      )
      topRows = graphic ? 3 : 1
      const prefs = taste ?? []
      if (prefs.length === 0) {
        lines.push(wrapped('taste-empty', 'Nothing learned yet. Say how you want things ("always…", "don\'t…", "bundan sonra…") and it is kept for every session.'))
      }
      for (const p of prefs) {
        const how = p.confidence >= 0.85 ? 'firm' : p.hits > 1 ? p.hits + '×' : 'once'
        const where = p.scope === 'global' ? 'everywhere' : p.scope === 'org' ? 'org ' + p.ref : 'this project'
        const forgetButton = (
          <Button
            key={'taste-forget-' + p.id}
            label="Forget"
            plain
            dimColor
            onPress={async () => {
              await cliText($, ['taste', 'forget', p.id])
              await loadTaste($)
            }}
          />
        )
        if (graphic) {
          lines.push(
            card(
              'taste-' + p.id,
              [
                <Box key={'th-' + p.id} flexDirection="row" columnGap="xs" alignItems="center">
                  {chip('ta-' + p.id, p.area, YOU)}
                  {chip('tw-' + p.id, where)}
                  <Box flexGrow={1} />
                  {forgetButton}
                </Box>,
                <Text key={'tr-' + p.id}>{p.rule}</Text>,
                <Box key={'tc-' + p.id} flexDirection="row" columnGap="xs" alignItems="center">
                  {bar('tb-' + p.id, [{ value: p.confidence, color: YOU }, { value: 1 - p.confidence, color: 'transparent' }], 90)}
                  <Text size="caption" dimColor>{how + ' · ' + where}</Text>
                </Box>,
              ],
              rowsFor(p.rule, width - 6) + 3,
            ),
          )
        } else {
          lines.push(
            line(
              'taste-' + p.id,
              <Box key={'taste-' + p.id} flexDirection="row" columnGap={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    <Text color="claude">{p.area}</Text> {p.rule} <Text dimColor>{how + ' · ' + where}</Text>
                  </Text>
                </Box>
                {forgetButton}
              </Box>,
              1,
            ),
          )
        }
      }
    } else if (tab === 'tasks') {
      const group = snapshot.tasks
      if (!group) {
        lines = [wrapped('no-tasks', 'No task group yet. Multi-step work shows up here once the agent calls create_task_group.')]
      } else {
        const sum = group.summary
        top = (
          <Box key="group-top" flexDirection="column" rowGap="xs" flexShrink={0}>
            <Text key="group-head" bold weight="semibold" wrap="truncate-end">
              {sum.task_group + '  ' + sum.completed + '/' + sum.total + (sum.failed ? ' · ' + sum.failed + ' failed' : '')}
            </Text>
            {bar('group-bar', [
              { value: sum.completed, color: STATUS_COLOR.completed },
              { value: sum.failed, color: STATUS_COLOR.failed },
              { value: sum.running, color: STATUS_COLOR.running },
              { value: sum.pending, color: 'transparent' },
            ])}
          </Box>
        )
        topRows = graphic ? 3 : 2
        for (const item of group.items) {
          lines.push(
            row('task-' + item.id, item.id + ' ' + item.title, {
              mark: GLYPH[item.status] ?? '?',
              markColor: STATUS_COLOR[item.status],
              dim: item.status === 'completed' || item.status === 'pending',
            }),
          )
          if (item.error) lines.push(line('task-err-' + item.id, <Text key={'task-err-' + item.id} color="error">{'    ' + item.error}</Text>, textRows(item.error)))
        }
      }
    } else if (tab === 'notes') {
      lines = snapshot.notes.length
        ? snapshot.notes.map(note => row('note-' + note.id, note.title, { mark: '✎', markColor: MUTED, note: day(note.created_at) + ' · ' + note.type }))
        : [wrapped('no-notes', 'No notes yet. /remember <text> saves one.')]
    } else if (tab === 'graph') {
      if (detail) {
        top = (
          <Box key="detail" flexDirection="column" rowGap="xs" backgroundColor={graphic ? CARD : undefined} borderStyle="round" borderColor={graphic ? CARD_EDGE : undefined} padding={graphic ? 'sm' : undefined} paddingX={graphic ? undefined : 1} flexShrink={0}>
            <Box flexDirection="row" columnGap="xs" alignItems="center">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold weight="semibold" size="heading" wrap="truncate-end">{detail.name}</Text>
              </Box>
              {chip('detail-type', detail.type, TYPE_COLOR[detail.type])}
            </Box>
            {detail.summary ? <Text dimColor wrap="truncate-end">{detail.summary}</Text> : null}
            {detail.facts.slice(0, 5).map((fact, i) => (
              <Text key={'df-' + i} wrap="truncate-end">• {fact}</Text>
            ))}
            {detail.facts.length > 5 ? <Text dimColor size="caption">+{detail.facts.length - 5} more fact(s)</Text> : null}
            {detail.relations.slice(0, 3).map((relation, i) => (
              <Text key={'dr-' + i} dimColor size="caption" wrap="truncate-end">↔ {relation}</Text>
            ))}
            <Box flexDirection="row" columnGap={1}>
              <Button key="close-detail" label="Close" onPress={() => update($, detailValue, () => null)} />
              <Button key="forget" label="Forget" onPress={() => forget($, detail.name)} />
            </Box>
          </Box>
        )
        topRows = graphic ? 4 + Math.min(5, detail.facts.length) * 1.45 + Math.min(3, detail.relations.length) * 1.2 + 4 : 4 + Math.min(5, detail.facts.length) + Math.min(3, detail.relations.length) + 2
      }
      lines = snapshot.entities.length
        ? snapshot.entities.map(entity =>
            row(entity.id, entity.name, {
              mark: '●',
              markColor: TYPE_COLOR[entity.entity_type] ?? MUTED,
              note: entity.entity_type + ' ' + dots(entity.importance),
              onPress: () => openDetail($, entity.name),
            }),
          )
        : [wrapped('graph-empty', 'The graph is empty. The agent fills it with remember.')]
    } else if (tab === 'rules') {
      if (!rules) {
        lines = [wrapped('rules-loading', 'Reading your rules…')]
      } else {
        lines.push(line('rules-head', <Text key="rules-head" bold weight="semibold">{'Rules for this session (' + rules.chars + ' characters)'}</Text>, graphic ? 1.6 : 1))
        lines.push(row('rules-source', 'from ' + rules.source, { dim: true }))
        if (rules.parts.length === 0) lines.push(wrapped('rules-none', 'No rules yet. Add some with `task-runner-mcp rules set "..."` or on the web page.'))
        rules.parts.forEach((part, i) => lines.push(row('part-' + i, part.label + ' ' + part.chars + ' chars', { mark: '§', markColor: MUTED })))
        lines.push(section('pending-head', rules.pending.length ? 'Waiting for your decision' : 'No proposals waiting'))
        for (const proposal of rules.pending) {
          lines.push(
            card(
              'proposal-' + proposal.id,
              [
                <Text key={'pw-' + proposal.id} bold weight="semibold" wrap="truncate-end">
                  {proposal.where} <Text dimColor>{proposal.mode} by {proposal.author}</Text>
                </Text>,
                ...(proposal.reason ? [<Text key={'py-' + proposal.id} dimColor size="caption" wrap="truncate-end">why: {proposal.reason}</Text>] : []),
                <Text key={'pt-' + proposal.id}>{proposal.text}</Text>,
                <Box key={'pb-' + proposal.id} flexDirection="row" columnGap={1}>
                  <Button key={'approve-' + proposal.id} label="Approve" variant="primary" onPress={() => decide($, 'approve', proposal.id)} />
                  <Button key={'reject-' + proposal.id} label="Reject" onPress={() => decide($, 'reject', proposal.id)} />
                </Box>,
              ],
              rowsFor(proposal.text, width - 6) + (proposal.reason ? 1 : 0) + 3,
            ),
          )
        }
      }
    } else if (tab === 'time') {
      if (!worklog) {
        lines = [wrapped('time-loading', 'Reading the session transcripts… the first run can take a minute.')]
      } else {
        top = (
          <Box key="time-top" flexDirection="column" rowGap={graphic ? 'sm' : 0} flexShrink={0}>
            <Text key="time-label" dimColor size="caption">{worklog.label}</Text>
            <Box flexDirection="row" columnGap={graphic ? 'sm' : 2} flexWrap="wrap">
              {stat('tt-you', 'You', hours(worklog.totals.you_s), YOU)}
              {stat('tt-agent', 'Agent', hours(worklog.totals.agent_s), AGENT)}
              {stat('tt-wall', 'Wall clock', hours(worklog.totals.wall_s), 'text')}
            </Box>
            {Svg ? <Svg key="week" alt="time per day" width={chartWidth} height={120} source={weekSvg(worklog.days, chartWidth)} /> : null}
          </Box>
        )
        topRows = graphic ? 7 + pxRows(120) + 1 : 2
        if (!Svg) {
          const peak = Math.max(1, ...worklog.days.map(d => d.you_s + d.agent_s))
          for (const d of worklog.days) {
            lines.push(
              line(
                'day-' + d.day,
                <Text key={'day-' + d.day} wrap="truncate-end">
                  <Text dimColor>{d.day.slice(5)} </Text>
                  <Text color={YOU}>{'█'.repeat(Math.round((d.you_s / peak) * 16))}</Text>
                  <Text color={AGENT}>{'█'.repeat(Math.round((d.agent_s / peak) * 16))}</Text>
                  {' ' + hours(d.you_s) + ' / ' + hours(d.agent_s)}
                </Text>,
                1,
              ),
            )
          }
        }
        lines.push(section('time-tasks', 'By task', worklog.rows.length))
        const most = Math.max(1, ...worklog.rows.map(r => r.you_s + r.agent_s))
        worklog.rows.forEach((r, i) =>
          lines.push(
            line(
              'row-' + i,
              <Box key={'row-' + i} flexDirection="row" columnGap={1} alignItems="center">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    <Text bold>{r.label}</Text> <Text dimColor>{r.project} · {r.kind}</Text>
                  </Text>
                </Box>
                {Svg ? bar('rb-' + i, [{ value: r.you_s, color: YOU }, { value: r.agent_s, color: AGENT }, { value: most - r.you_s - r.agent_s, color: 'transparent' }], 90) : null}
                <Text dimColor size="caption">{'you ' + hours(r.you_s) + ' · agent ' + hours(r.agent_s)}</Text>
              </Box>,
              graphic ? 1.7 : 1,
            ),
          ),
        )
        lines.push(wrapped('time-more', '/worklog prints the full report with notes and commits.'))
      }
    } else {
      top = Input ? (
        <Input key="query" label="Search" placeholder="keywords, any language" value={search?.query ?? ''} submitLabel="search" onSubmit={text => runSearch($, text)} />
      ) : (
        <Text key="query-hint" dimColor>Type /recall &lt;keywords&gt; to search.</Text>
      )
      topRows = graphic ? 3.5 : 2
      if (search && search.entities.length === 0 && search.notes.length === 0) lines.push(wrapped('nothing', 'Nothing found.'))
      for (const entity of search?.entities ?? []) {
        const text = entity.facts.join('; ')
        lines.push(
          line(
            'hit-' + entity.entity_type + '-' + entity.name,
            <Box key={'hit-' + entity.entity_type + '-' + entity.name} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={TYPE_COLOR[entity.entity_type] ?? MUTED}>● </Text>
                <Text bold>{entity.name}</Text> <Text dimColor size="caption">{entity.entity_type}</Text>
              </Text>
              <Text dimColor>{text}</Text>
            </Box>,
            (graphic ? 1.6 : 1) + textRows(text),
          ),
        )
      }
      ;(search?.notes ?? []).forEach((note, i) => lines.push(row('hit-note-' + i, note, { mark: '✎', markColor: MUTED, dim: true })))
    }

    // ── header ──
    const where = (session?.location ?? '').startsWith('server') ? 'server' : 'this machine'
    const header = graphic ? (
      <Box key="head" flexDirection="column" rowGap="sm" flexShrink={0}>
        <Box flexDirection="row" alignItems="center" columnGap="sm">
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="heading" weight="semibold" wrap="truncate-end">{snapshot?.project ?? 'Task Runner'}</Text>
            <Text size="caption" dimColor wrap="truncate-end">
              {(snapshot?.branch ? '⎇ ' + snapshot.branch + ' · ' : '') +
                (snapshot ? snapshot.stats.entities + ' entities · ' + snapshot.stats.entries + ' notes · ' : '') +
                'memory on ' + where}
            </Text>
          </Box>
          <Button key="refresh" label="↻" plain onPress={reload} />
        </Box>
        <Box flexDirection="row" columnGap="xs" flexWrap="wrap">
          {TABS.map(item => (
            <Button key={'tab-' + item.id} label={item.label} variant={tab === item.id ? 'primary' : 'secondary'} onPress={() => select(item.id)} />
          ))}
        </Box>
      </Box>
    ) : (
      <Box key="head" flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text bold color="claude">{snapshot?.project ?? 'Task Runner'}</Text>
              <Text dimColor>{(snapshot?.branch ? ' ⎇ ' + snapshot.branch : '') + ' · memory on ' + where}</Text>
            </Text>
          </Box>
          <Button key="refresh" label="↻" plain hotkey="r" onPress={reload} />
        </Box>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {TABS.map((item, i) => (
            <Button key={'tab-' + item.id} plain hotkey={String(i + 1)} dimColor={tab !== item.id} onPress={() => select(item.id)}>
              {tab === item.id ? <Text bold color="claude">{item.label}</Text> : item.label}
            </Button>
          ))}
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(10, width - 1))}</Text>
      </Box>
    )
    const headerRows = graphic ? 7.5 : 3 + (width < 70 ? 1 : 0)

    // ── the window over the list ──
    const footerRows = graphic ? 2.5 : 1
    const room = fullHeight ? Math.max(3, fullHeight - headerRows - topRows - footerRows) : Infinity
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
        <Box key="pager" flexDirection="row" columnGap={2} justifyContent="center" flexShrink={0}>
          {above ? <Button key="page-up" label={'↑ ' + above + ' more'} plain dimColor hotkey={graphic ? undefined : 'k'} onPress={() => moveList($, -Math.max(1, end - start - 1))} /> : null}
          {below ? <Button key="page-down" label={'↓ ' + below + ' more'} plain dimColor hotkey={graphic ? undefined : 'j'} onPress={() => moveList($, Math.max(1, end - start - 1))} /> : null}
        </Box>
      ) : null

    const body = (
      <Box key="pane-top" flexDirection="column" height={fullHeight} overflow="hidden" rowGap={graphic ? 'sm' : 0} padding={graphic ? 'xs' : undefined}>
        {header}
        {top}
        <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" rowGap={graphic ? 'xs' : 0}>
          {lines.slice(start, end).map(l => l.node)}
        </Box>
        {pager}
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
