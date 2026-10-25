import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type TestOn = Parameters<TestBody>[1]

const SNAPSHOT = {
  project: 'acme-web',
  branch: 'main',
  stats: { entities: 2, relations: 1, observations: 3, entries: 1, tasks: 3, orphan_entities: 0 },
  tasks: {
    summary: { task_group: 'ship-it', total: 3, pending: 1, running: 1, completed: 1, failed: 0 },
    items: [
      { id: 'task-001', title: 'Build', status: 'completed', error: null },
      { id: 'task-002', title: 'Test', status: 'running', error: null },
      { id: 'task-003', title: 'Release', status: 'pending', error: null },
    ],
  },
  notes: [{ id: 'entry_1', type: 'decision', title: 'Use SQLite', created_at: 1_700_000_000 }],
  entities: [
    { id: 'ent_1', name: 'Retry on 429', entity_type: 'pitfall', summary: null, importance: 0.8, project_key: 'acme-web' },
  ],
  search: {
    entities: [{ name: 'Retry on 429', entity_type: 'pitfall', observations: [{ content: 'Back off with jitter' }] }],
    entries: [{ type: 'decision', title: 'Use SQLite' }],
  },
}

const PANE = {
  plugin: 'task-runner',
  component: 'Pane',
  requestId: 'brain',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'Task Runner',
    isFocused: true,
    bodyColumns: 70,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'task-runner',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const run = ($: Parameters<TestBody>[0], command: string, args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const submit = ($: Parameters<TestBody>[0], text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

// What every test needs from beneath the plugin: where the session runs, which session it is, a clock.
function base(on: TestOn) {
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.after', () => ({ value: undefined }))
  // The cross-session store, in memory.
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
}

function stubCli(on: TestOn, toasts: string[] = []) {
  base(on)
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(e.argv.includes('session') ? SESSION : SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'stub' } }))
}

// One test per surface: a state update in one mount must not reach a drawing that was already unmounted.
for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the pane shows tasks, notes and the graph on ${surface}`, async ($, on) => {
    stubCli(on)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'tab-tasks' })

    expect(await ui.find({ type: 'Text', text: /ship-it .* 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /task-002 Test/ })).toBeDefined()

    await ui.press({ key: 'tab-notes' })
    expect(await ui.find({ type: 'Text', text: /Use SQLite/ })).toBeDefined()

    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ key: 'ent_1' })).toBeDefined()
    await ui.unmount()
  })
}

test('searching from the pane lists matching facts', async ($, on) => {
  stubCli(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-search' })
  await ui.input({ key: 'query', text: 'jitter' })

  expect(await ui.find({ type: 'Text', text: /Back off with jitter/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows progress only while tasks are open', async ($, on) => {
  stubCli(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await quiet.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'refresh' })
  await pane.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /ship-it .* 1\/3 · ▶ Test/ })).toBeDefined()
  await band.unmount()
})

test('memory writes by the agent raise a toast, failures and reads do not', async ($, on) => {
  const toasts: string[] = []
  stubCli(on, toasts)
  on('tool.call', (_, e) => (e.tool.endsWith('forget') ? { result: { isError: true } } : { result: 'ok' }))

  await $.tool.call({ tool: 'mcp__plugin_task-runner_task-runner__remember', name: 'Cache', entity_type: 'pattern' })
  await $.tool.call({ tool: 'mcp__task-runner__link', from_name: 'Cache', to_name: 'Redis' })
  await $.tool.call({ tool: 'mcp__task-runner__recall', query: 'cache' })

  expect(toasts).toEqual([
    'task-runner: remembered Cache (pattern)',
    'task-runner: linked Cache → Redis',
  ])
})

test('an unsaved session gets one reminder on the next prompt', async ($, on) => {
  const toasts: string[] = []
  stubCli(on, toasts)
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  let submitted = null as { context?: readonly string[] } | null
  on('prompt.submit', (_, e) => {
    submitted = e
    return { text: e.text }
  })

  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(toasts.some(t => /nothing saved to memory/.test(t))).toBe(true)

  await submit($, 'continue')
  expect(submitted?.context?.[0]).toMatch(/without saving anything to memory/)

  await submit($, 'again')
  expect(submitted?.context).toBeUndefined()
})

test('saving memory resets the reminder', async ($, on) => {
  stubCli(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  let submitted = null as { context?: readonly string[] } | null
  on('prompt.submit', (_, e) => {
    submitted = e
    return { text: e.text }
  })

  for (let i = 0; i < 8; i++) await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' })
  await $.tool.call({ tool: 'mcp__task-runner__save_memory', type: 'note', title: 't', content: 'c' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await submit($, 'continue')
  expect(submitted?.context).toBeUndefined()
})

test('the reminder can be switched off', { options: { nudge: false } }, async ($, on) => {
  stubCli(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  let submitted = null as { context?: readonly string[] } | null
  on('prompt.submit', (_, e) => {
    submitted = e
    return { text: e.text }
  })

  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await submit($, 'continue')
  expect(submitted?.context).toBeUndefined()
})

test('/recall prints facts and notes, /remember saves a note', async ($, on) => {
  stubCli(on)

  const found = await run($, 'recall', 'jitter')
  expect(found.text).toContain('pitfall Retry on 429: Back off with jitter')
  expect(found.text).toContain('[decision] Use SQLite')

  expect((await run($, 'recall', '  ')).text).toMatch(/Usage/)
  expect((await run($, 'remember', 'ship friday')).text).toMatch(/Saved/)
})

test('its own memory tools skip the prompt, clear_tasks and other servers do not', async ($, on) => {
  stubCli(on)
  on('tool.check', () => ({ decision: 'ask' }))

  const remember = await $.tool.check({ tool: 'mcp__plugin_task-runner_task-runner__remember', input: {} })
  expect(remember.decision).toBe('allow')
  const recall = await $.tool.check({ tool: 'mcp__plugin_task-runner_task-runner__recall', input: {} })
  expect(recall.decision).toBe('allow')
  const clear = await $.tool.check({ tool: 'mcp__plugin_task-runner_task-runner__clear_tasks', input: {} })
  expect(clear.decision).toBe('ask')
  const other = await $.tool.check({ tool: 'mcp__other__remember', input: {} })
  expect(other.decision).toBe('ask')
})

test('a deny from the rules is never overridden', async ($, on) => {
  stubCli(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'blocked by rule' }))
  const res = await $.tool.check({ tool: 'mcp__plugin_task-runner_task-runner__remember', input: {} })
  expect(res.decision).toBe('deny')
})

test('approval can be switched off', { options: { approve: false } }, async ($, on) => {
  stubCli(on)
  on('tool.check', () => ({ decision: 'ask' }))
  const res = await $.tool.check({ tool: 'mcp__plugin_task-runner_task-runner__remember', input: {} })
  expect(res.decision).toBe('ask')
})

test('a commit is recorded as a change note without the model', async ($, on) => {
  const notes: string[][] = []
  base(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      return { value: { exitCode: 0, stdout: 'abc1234 feat: add cache\n\n 2 files changed, 9 insertions(+)', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv.includes('note')) notes.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: add cache"' })
  for (let i = 0; i < 50 && notes.length === 0; i++) await Promise.resolve()

  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('commit abc1234 feat: add cache (2 files changed, 9 insertions(+))')
  expect(notes[0]).toContain('change')

  await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(notes.length).toBe(1)
})

const REPORT = {
  range: { label: 'Week 2026-10-19 to 2026-10-25' },
  totals: { you_s: 4500, agent_s: 36000, wall_s: 30000, tasks: 2, projects: 1 },
  days: [
    { day: '2026-10-20', you_s: 1800, agent_s: 14400 },
    { day: '2026-10-21', you_s: 2700, agent_s: 21600 },
  ],
  rows: [
    { project: 'acme-shop', label: 'SHOP-9', kind: 'feature', you_s: 3000, agent_s: 30000, wall_s: 25000 },
    { project: 'acme-shop', label: 'fix/null', kind: 'fix', you_s: 1500, agent_s: 6000, wall_s: 5000 },
  ],
}

test('the Time tab lists the week per task', async ($, on) => {
  base(on)
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const out = e.argv.includes('worklog') ? REPORT : SNAPSHOT
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-time' })

  expect(await ui.find({ type: 'Text', text: /1h 15m You/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /10h 00m Agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SHOP-9 acme-shop · feature/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'you 50m · agent 8h 20m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /10-21 .* 45m \/ 6h 00m/ })).toBeDefined()
  await ui.unmount()
})

test('/worklog prints the report and rejects unknown periods', async ($, on) => {
  const calls: string[][] = []
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'Week 2026-10-19 to 2026-10-25\nYou 1h', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const out = await run($, 'worklog', 'last-week')
  expect(out.text).toContain('You 1h')
  expect(calls[0]).toContain('--last-week')
  expect(calls[0]).toContain('--detail')

  expect((await run($, 'worklog', 'fortnight')).text).toMatch(/Usage/)
})

const RULES_SHOWN = {
  parts: [
    { label: 'Everywhere', chars: 40 },
    { label: 'Project acme-shop', chars: 120 },
  ],
  chars: 190,
  source: 'server https://rules.example.dev',
}
const PENDING = [
  { id: 'prop_1', where: 'org acme', mode: 'append', author: 'agent', reason: 'asked twice', text: 'Use Conventional Commits.' },
]

test('the Rules tab lists proposals and approving calls the CLI', async ($, on) => {
  const calls: string[][] = []
  base(on)
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const out = e.argv.includes('--json') ? (e.argv.includes('pending') ? PENDING : RULES_SHOWN) : e.argv.includes('approve') ? { approved: 'prop_1' } : SNAPSHOT
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-rules' })

  expect(await ui.find({ type: 'Text', text: /Rules for this session \(190 characters\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Project acme-shop 120 chars/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Use Conventional Commits.' })).toBeDefined()

  await ui.press({ key: 'approve-prop_1' })
  expect(calls.some(c => c.includes('approve') && c.includes('prop_1'))).toBe(true)
  await ui.unmount()
})

test('a rule proposed by the agent raises a toast', async ($, on) => {
  const toasts: string[] = []
  stubCli(on, toasts)
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'mcp__plugin_task-runner_task-runner__rules', action: 'propose', scope: 'global', text: 'x' })
  await $.tool.call({ tool: 'mcp__plugin_task-runner_task-runner__rules', action: 'show' })
  expect(toasts.filter(t => /proposed a rule/.test(t)).length).toBe(1)
})

test('/rules shows the rules and approves by id', async ($, on) => {
  const calls: string[][] = []
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const stdout = e.argv.includes('show') ? 'RULES from the user\n## Everywhere\nBe brief.' : e.argv.includes('pending') ? 'No proposals are waiting.' : '{"approved":"prop_9"}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const shown = await run($, 'rules', '')
  expect(shown.text).toContain('Be brief.')
  expect(shown.text).not.toContain('Waiting for your decision')

  const approved = await run($, 'rules', 'approve prop_9')
  expect(approved.text).toContain('prop_9')
  expect(calls.some(c => c.includes('approve') && c.includes('prop_9'))).toBe(true)
  expect((await run($, 'rules', 'reject')).text).toMatch(/Usage/)
})

const SESSION = {
  project: 'acme-web',
  branch: 'main',
  location: '/home/u/.task-runner/memory.db',
  you_s: 900,
  agent_s: 5400,
  wall_s: 6000,
  started_at: 1_700_000_000,
  prompts: 7,
  edits: 12,
  first_prompt: 'add a cart page',
  scopes: [{ project_key: 'acme-web', branch: 'main', secs: 6300 }],
  entities: [
    { name: 'payments-service', entity_type: 'component', is_new: true, new_facts: 1, at: 1_700_000_100 },
    { name: 'redis', entity_type: 'technology', is_new: false, new_facts: 2, at: 1_700_000_200 },
  ],
  notes: [{ id: 'entry_9', type: 'decision', title: 'Keep the pool at 10', created_at: 1_700_000_300 }],
}

function stubSession(on: TestOn, session: unknown = SESSION) {
  base(on)
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'stub' } }))
  on('process.run', (_, e) => {
    const out = e.argv.includes('session') ? session : SNAPSHOT
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the Session tab opens first and shows this session's time and saves on ${surface}`, async ($, on) => {
    stubSession(on)
    // Desktop rows are shorter than its text, so it gets a taller pane.
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, scroll: { offset: 0, bodyRows: surface === 'desktop' ? 40 : 20 } } })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ type: 'Text', text: /15m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1h 30m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7 prompt\(s\) · 12 file edit\(s\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /saved to memory this session \(3\)/i })).toBeDefined()
    expect(await ui.find({ key: 'se-component-payments-service' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Keep the pool at 10/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a long list pages inside the pane and the tabs stay in view', async ($, on) => {
  const many = { ...SESSION, entities: [], notes: Array.from({ length: 40 }, (_, i) => ({ id: 'n' + i, type: 'note', title: 'Note number ' + i, created_at: 1_700_000_000 + i })) }
  stubSession(on, many)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ key: 'tab-session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Note number 0 / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Note number 39 / })).toBeUndefined()
  expect(await ui.find({ key: 'page-down' })).toBeDefined()

  await ui.press({ key: 'page-down' })
  expect(await ui.find({ key: 'page-up' })).toBeDefined()
  expect(await ui.find({ key: 'tab-session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Note number 0 / })).toBeUndefined()
  await ui.unmount()
})

const PREFS = {
  preferences: [
    { id: 'taste_1', scope: 'global', ref: '', area: 'replies', rule: 'Answer in Turkish.', confidence: 0.75, hits: 2, replaced: null },
  ],
}

function stubTaste(on: TestOn, forks: string[], learnCalls: string[][], reply = '{"items":[{"action":"new","scope":"global","area":"commits","rule":"Use one-line commit messages."}]}') {
  base(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'stub' } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } as never }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    let out: unknown = SNAPSHOT
    if (argv.includes('taste') && argv.includes('learn')) {
      learnCalls.push(argv)
      out = { learned: [{ id: 'taste_2', action: 'new', rule: 'Use one-line commit messages.', confidence: 0.5 }] }
    } else if (argv.includes('taste')) out = PREFS
    else if (argv.includes('session')) out = SESSION
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

test('a preference said in a prompt is learned after the turn and told to the agent with the next prompt', async ($, on) => {
  const forks: string[] = []
  const learnCalls: string[][] = []
  stubTaste(on, forks, learnCalls)
  let submitted = null as { context?: readonly string[] } | null
  on('prompt.submit', (_, e) => {
    submitted = e
    return { text: e.text }
  })

  await submit($, 'commit mesajları hep tek satır olsun, body yazma')
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await settle()

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('commit mesajları hep tek satır olsun')
  expect(learnCalls.length).toBe(1)
  expect(learnCalls[0]!.join(' ')).toContain('Use one-line commit messages.')

  await submit($, 'devam et')
  expect(submitted?.context?.some(c => /Learned from the user[\s\S]*Use one-line commit messages\./.test(c))).toBe(true)
  await submit($, 'tamam')
  expect(submitted?.context).toBeUndefined()
})

test('a prompt without a preference costs no model call', async ($, on) => {
  const forks: string[] = []
  stubTaste(on, forks, [])
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await submit($, 'run the build')
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await settle()
  expect(forks.length).toBe(0)
})

test('/taste off stops learning for the session and /taste on reads what was said so far', async ($, on) => {
  const forks: string[] = []
  stubTaste(on, forks, [])
  on('prompt.submit', (_, e) => ({ text: e.text }))

  expect((await run($, 'taste', 'off')).text).toMatch(/off for this session/)
  await submit($, 'never use emojis in replies')
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await settle()
  expect(forks.length).toBe(0)

  expect((await run($, 'taste', 'on')).text).toMatch(/on for this session\. From the messages so far: 1/)
  expect(forks[0]).toContain('every message the user wrote in this conversation')
  expect((await run($, 'taste', '')).text).toContain('Learning is on')
})

test('the Taste tab lists what was learned and can turn learning off', async ($, on) => {
  stubTaste(on, [], [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-taste' })
  expect(await ui.find({ type: 'Text', text: /replies Answer in Turkish\. 2× · everywhere/ })).toBeDefined()
  await ui.press({ key: 'taste-toggle' })
  expect(await ui.find({ type: 'Text', text: /Learning is off in this session/ })).toBeDefined()
  await ui.unmount()
})

test('the panel opens once when an interactive session starts and not again after a reload', { options: { openOnStart: true } }, async ($, on) => {
  stubCli(on)
  on('session.start', () => ({ cwd: '/work/acme' }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  await $.session.start({ cwd: '/work/acme', surface: null, isInteractive: false })
  await settle()
  expect(opened).toEqual([])
  await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
  await settle()
  expect(opened).toEqual(['brain'])
  await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
  await settle()
  expect(opened).toEqual(['brain'])
})

test('by default the panel stays closed, and /brain auto on turns opening on', async ($, on) => {
  stubCli(on)
  on('session.start', () => ({ cwd: '/work/acme' }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
  await settle()
  expect(opened).toEqual([])

  expect((await run($, 'brain', 'auto on')).text).toMatch(/opens at the start of every session/)
  expect(opened).toEqual([])
  expect((await run($, 'brain', 'auto off')).text).toMatch(/no longer opens/)
  expect(opened).toEqual([])
})
