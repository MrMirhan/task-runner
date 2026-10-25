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

const submit = ($: Parameters<TestBody>[0], text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

function stubCli(on: TestOn, toasts: string[] = []) {
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

  const found = await $.command.run({ command: 'recall', args: 'jitter' })
  expect(found.text).toContain('pitfall Retry on 429: Back off with jitter')
  expect(found.text).toContain('[decision] Use SQLite')

  expect((await $.command.run({ command: 'recall', args: '  ' })).text).toMatch(/Usage/)
  expect((await $.command.run({ command: 'remember', args: 'ship friday' })).text).toMatch(/Saved/)
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
  on('session.cwd', () => ({ value: '/work/acme' }))
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
