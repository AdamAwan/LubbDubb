import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, RenderElement } from 'claude-code'

const BOARD: CommandRunInput = {
  command: 'board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

const STATE = {
  escalations: [{ id: 'e1', prompt: 'Which branch should 284 go on?\nmore detail' }],
  proposals: [
    { id: 'p1', kind: 'merge', ref: 'pr:412', status: 'pending' },
    { id: 'p2', kind: 'merge', ref: 'pr:400', status: 'accepted' },
  ],
  humanTasks: [{ id: 't1', title: 'Log in to staging', status: 'open' }],
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

  expect(asked).toEqual([{ url: 'http://127.0.0.1:4300/api/state?sections=inbox,control', auth: 'Bearer secret' }])
  expect(out.text).toContain('1 question · 1 to approve · 1 task for you · fleet paused')
  expect(out.text).toContain('- question: Which branch should 284 go on?')
  expect(out.text).toContain('- approval: merge on pr:412')
  expect(out.text).not.toContain('pr:400')
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
      plugin: 'lubbdubb-board',
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
    expect(await ui.find({ type: 'Text', text: /1 question · 1 to approve/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /LubbDubb/ })).toBeUndefined()
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
  state = { ...STATE, escalations: [...STATE.escalations, { id: 'e2', prompt: 'Approve the plan for 300?' }] }
  await $.command.run(BOARD)

  expect(toasts).toEqual(['LubbDubb: Approve the plan for 300?'])
})
