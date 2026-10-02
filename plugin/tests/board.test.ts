import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, RenderElement } from 'claude-code'

const BOARD: CommandRunInput = {
  command: 'board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

const ask = (id: string, kind: string, title: string, focusRank: number, standing = true) => ({
  id,
  kind,
  title,
  focusRank,
  standing,
})

const STATE = {
  asks: [
    ask('e1', 'escalation', 'Which branch should 284 go on?\nmore detail', 1),
    ask('e2', 'merge', 'Merge #412', 0),
    ask('hum_1', 'bench', 'Log in to staging', 2),
    ask('setup:node', 'config', 'Node is fine now', 3, false),
  ],
  control: { paused: true },
}

test('lists what the harness waits on, with the token from the environment', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  const asked: { url: string; auth?: string }[] = []
  on('http.fetch', async (_$, e) => {
    asked.push({ url: e.url, auth: e.init?.headers?.authorization })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } }
  })

  const out = await $.command.run(BOARD)

  expect(asked).toEqual([{ url: 'http://127.0.0.1:4300/api/state?sections=asks,control', auth: 'Bearer secret' }])
  expect(out.text).toContain('3 asks · next: Merge #412 · fleet paused')
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

test('draws the band, and nothing once hidden', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  await $.command.run(BOARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'lubbdubb',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 4,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    })
    expect(
      await ui.find({ type: 'Text', text: /3 asks · next: Merge #412 · fleet paused · \/lubbdubb:next/ }),
    ).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /LubbDubb/ })).toBeUndefined()
    await ui.unmount()
    await $.command.run(BOARD)
  }
})

test('leaves room for a band drawn beneath it, and hides only its own row', async ($, on) => {
  mock.env(on, { LUBBDUBB_TOKEN: 'secret' })
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'pr-watch · 2 checks failing') as RenderElement
  })
  await $.command.run(BOARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'lubbdubb',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 4,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /3 asks · next: Merge #412/ })).toBeDefined()
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
  let state = STATE
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(state) } }))
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
