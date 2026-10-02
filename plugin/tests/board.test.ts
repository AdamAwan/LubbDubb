import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, RenderElement } from 'claude-code'

const command = (name: string): CommandRunInput => ({
  command: name,
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})
const BOARD = command('board')
const PANEL = command('panel')

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
}

const PANE = {
  title: 'LubbDubb',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const ask = (id: string, kind: string, title: string, focusRank: number, standing = true, urgency = 'next') => ({
  id,
  kind,
  title,
  focusRank,
  standing,
  urgency,
})

const pr = (number: number, title: string, rest: Record<string, unknown> = {}) => ({
  number,
  title,
  ciStatus: 'passing',
  unresolvedComments: [],
  state: 'open',
  ...rest,
})

const STATE = {
  asks: [
    ask('e1', 'escalation', 'Which branch should 284 go on?\nmore detail', 1),
    ask('e2', 'merge', 'Merge #412', 0, true, 'now'),
    ask('hum_1', 'bench', 'Log in to staging', 2),
    ask('setup:node', 'config', 'Node is fine now', 3, false),
  ],
  control: { paused: true, cap: 4 },
  agents: [
    { id: 'ag1', taskId: 't1', status: 'running', costUsd: 1.5, startedAt: '2026-10-02T10:00:00Z' },
    { id: 'ag2', taskId: 't2', status: 'done', costUsd: 0.2, startedAt: '2026-10-02T09:00:00Z' },
  ],
  tasks: [
    { id: 't1', title: 'Fix the arrival sheet' },
    { id: 't2', title: 'Already finished' },
  ],
  upcoming: { items: [{ origin: 'issue:300', title: 'Story sequencing', status: 'dispatching' }] },
  world: {
    pullRequests: [
      pr(412, 'Retry webhooks', { approved: true, mergeableState: 'clean' }),
      pr(413, 'Arrival sheet', { ciStatus: 'failing' }),
      pr(414, 'Old one', { state: 'merged' }),
    ],
  },
  refUrls: { 'pr:412': 'https://github.com/o/r/pull/412', 'pr:413': 'not a url' },
}

const FEATURES = {
  features: [
    {
      number: 90,
      title: 'Arrival sheet v2',
      counts: { delivered: 2, inFlight: 1, settled: 1, total: 6 },
      briefing: { blockingTotal: 1 },
    },
    {
      number: 91,
      title: 'All done',
      counts: { delivered: 3, inFlight: 0, settled: 0, total: 3 },
      briefing: { blockingTotal: 0 },
    },
  ],
}

type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const ok = (body: unknown): { value: Reply } => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

function harness(on: Parameters<Parameters<typeof test>[1]>[1], state: () => unknown = () => STATE) {
  const asked: { url: string; method?: string; body?: string; auth?: string }[] = []
  on('http.fetch', async (_$, e) => {
    asked.push({ url: e.url, method: e.init?.method, body: e.init?.body as string | undefined, auth: e.init?.headers?.authorization })
    if (e.url.endsWith('/api/features')) return ok(FEATURES)
    if (e.url.endsWith('/api/control')) return ok({ ok: true, cap: 4, paused: false })
    return ok(state())
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  return asked
}

test('reads the state and the feature board, with the token from the environment', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  const asked = harness(on)

  const out = await $.command.run(BOARD)

  expect(asked).toEqual([
    { url: 'http://127.0.0.1:4300/api/state?sections=asks,control,fleet,queue,goals', auth: 'Bearer secret' },
    { url: 'http://127.0.0.1:4300/api/features', auth: 'Bearer secret' },
  ])
  expect(out.text).toContain('fleet paused · 1/4 agents · 3 asks (1 blocking) · next: Merge #412')
  expect(out.text).toContain('1. merge: Merge #412')
  expect(out.text).toContain('2. escalation: Which branch should 284 go on?')
  expect(out.text).toContain('3. bench: Log in to staging')
  expect(out.text).toContain('/lubbdubb:next')
  expect(out.text).not.toContain('Node is fine now')
})

test('says so when the harness does not answer', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  on('http.fetch', async () => ({ value: { status: 401, ok: false, headers: {}, text: '' } }))

  const out = await $.command.run(BOARD)

  expect(out.text).toBe('LubbDubb is not answering at http://127.0.0.1:4300.')
})

test('draws the boxed band, and nothing once hidden', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  harness(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  await $.command.run(BOARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lubbdubb', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'band' }))?.props).toMatchObject({ borderStyle: 'round' })
    expect(await ui.find({ type: 'Text', text: /3 asks \(1 blocking\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next: Merge #412/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 feature$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 PR needs attention/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 ready to merge/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /LubbDubb/ })).toBeUndefined()
    await ui.unmount()
    await $.command.run(BOARD)
  }
})

test('leaves room for a band drawn beneath it, outside its box, and hides only its own row', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  harness(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'pr-watch · 2 checks failing') as RenderElement
  })
  await $.command.run(BOARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lubbdubb', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /next: Merge #412/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pr-watch/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /LubbDubb/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /pr-watch/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(BOARD)
  }
})

test('toasts only what is new since the last look', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  let state: unknown = STATE
  harness(on, () => state)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })

  await $.command.run(BOARD)
  state = { ...STATE, asks: [...STATE.asks, ask('e3', 'plan', 'Approve the plan for 300?', 0)] }
  await $.command.run(BOARD)

  expect(toasts).toEqual(['LubbDubb: Approve the plan for 300?'])
})

test('the panel draws asks, unfinished features, open pull requests, live agents and the queue', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  harness(on)
  await $.command.run(PANEL)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lubbdubb', surface, component: 'Pane', requestId: 'lubbdubb', props: PANE })
    expect(await ui.find({ key: 'ask-e2-go', text: 'Merge #412' })).toBeDefined()
    expect(await ui.find({ key: 'feature-90-ask', text: 'Arrival sheet v2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3/6' })).toBeDefined()
    expect(await ui.find({ key: 'feature-91-ask' })).toBeUndefined()
    expect((await ui.find({ type: 'Link', text: '#412 Retry webhooks' }))?.props).toMatchObject({
      href: 'https://github.com/o/r/pull/412',
    })
    expect(await ui.find({ type: 'Link', text: '#413' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'ready to merge' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#413 Arrival sheet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CI failing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Old one/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Fix the arrival sheet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Already finished/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Story sequencing' })).toBeDefined()
    await ui.unmount()
  }
})

test('the panel only drafts into the prompt box; it never sends', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  harness(on)
  const filled: string[] = []
  const sent: string[] = []
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { value: { isFilled: true, text: e.text, cursor: e.text.length } }
  })
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { value: { text: e.text } }
  })
  await $.command.run(PANEL)

  const ui = await $.ui.mount({ plugin: 'lubbdubb', surface: 'desktop', component: 'Pane', requestId: 'lubbdubb', props: PANE })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'feature-90-ask' })
  await ui.press({ key: 'ask-e2-go' })
  await ui.unmount()

  expect(sent).toEqual([])
  expect(filled).toEqual([
    'Work through what LubbDubb is waiting on me for, one ask at a time.',
    'What\'s the state of LubbDubb feature #90 "Arrival sheet v2"? What has been delivered, what is in flight, and what is blocking it?',
    'Help me decide LubbDubb ask e2 (merge): Merge #412',
  ])
})

test('pause and resume go through the cockpit\'s own control route', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  const asked = harness(on)
  await $.command.run(PANEL)

  const ui = await $.ui.mount({ plugin: 'lubbdubb', surface: 'terminal', component: 'Pane', requestId: 'lubbdubb', props: PANE })
  await ui.press({ key: 'pause' })
  await ui.unmount()

  expect(asked.filter(a => a.url.endsWith('/api/control'))).toEqual([
    { url: 'http://127.0.0.1:4300/api/control', method: 'POST', body: '{"paused":false}', auth: 'Bearer secret' },
  ])
})

test('the panel says so when the harness does not answer', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  on('http.fetch', async () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.command.run(PANEL)

  const ui = await $.ui.mount({ plugin: 'lubbdubb', surface: 'terminal', component: 'Pane', requestId: 'lubbdubb', props: PANE })
  expect(await ui.find({ type: 'Text', text: 'LubbDubb is not answering at http://127.0.0.1:4300.' })).toBeDefined()
  await ui.unmount()
})
