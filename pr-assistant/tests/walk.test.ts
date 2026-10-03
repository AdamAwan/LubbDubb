import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On, RenderElement } from 'claude-code'

const PANE = {
  title: 'PR walkthrough',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

const PANEL: CommandRunInput = {
  command: 'walk-panel',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}

const START = {
  tool: 'mcp__pr-assistant__walk_start' as const,
  pr: { number: 1091, title: 'Count description-check attempts per version', url: 'https://github.com/o/r/pull/1091' },
  summary: 'Each description version gets its own 3 tries.',
  stops: [
    { title: 'You write version 4', kind: 'unchanged' },
    { title: 'Store returns authoredAt', kind: 'changed', files: ['src/store/prDescriptions.ts'] },
    { title: 'Ask a person at the cap', kind: 'new' },
  ],
}

const HUNK = "@@ -1,2 +1,2 @@\n-  'SELECT pr_ref, body'\n+  'SELECT pr_ref, body, authored_at'\n   ).all()\n"

function quiet(on: On) {
  const opened: string[] = []
  const said: string[] = []
  const filled: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('prompt.submit', async (_$, e) => {
    said.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  return { opened, said, filled }
}

test('a walk start lays out the stops and opens the panel', async ($, on) => {
  const seen = quiet(on)

  const out = await $.tool.call(START)

  expect(out.result).toBe('Panel open on #1091 with 3 stops. Call walk_goto as you reach each one.')
  expect(seen.opened).toEqual(['pr-walk'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-assistant', surface, component: 'Pane', requestId: 'pr-walk', props: PANE })
    expect(await ui.find({ type: 'Link', text: /#1091 Count description-check/ })).toBeDefined()
    expect(await ui.find({ key: 'stop-2-go', text: '2. Store returns authoredAt' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing flagged yet.' })).toBeDefined()
    await ui.unmount()
  }
})

test('going to a stop shows its hunk, and the stop buttons ask for it in the chat', async ($, on) => {
  const seen = quiet(on)
  await $.tool.call(START)

  const out = await $.tool.call({ tool: 'mcp__pr-assistant__walk_goto', stop: 2, diff: HUNK, path: 'src/store/prDescriptions.ts' })

  expect(out.result).toBe('Panel on stop 2 of 3.')
  const ui = await $.ui.mount({ plugin: 'pr-assistant', surface: 'terminal', component: 'Pane', requestId: 'pr-walk', props: PANE })
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff', source: HUNK })
  expect(await ui.find({ type: 'Text', text: '2 of 3' })).toBeDefined()
  await ui.press({ key: 'next' })
  await ui.press({ key: 'stop-3-go' })
  await ui.unmount()
  expect(seen.said).toEqual(['Next.', 'Go to stop 3.'])
})

test('notes are added, cleared, and offered as a review', async ($, on) => {
  const seen = quiet(on)
  await $.tool.call(START)
  await $.tool.call({ tool: 'mcp__pr-assistant__walk_goto', stop: 2 })

  const added = await $.tool.call({
    tool: 'mcp__pr-assistant__walk_note',
    kind: 'check',
    text: 'Is authored_at a new column?',
    file: 'src/store/prDescriptions.ts',
    line: 12,
  })
  await $.tool.call({ tool: 'mcp__pr-assistant__walk_note', kind: 'likely', text: 'The 200-decision window can miss tries.' })
  const cleared = await $.tool.call({ tool: 'mcp__pr-assistant__walk_note', action: 'clear', id: 1 })

  expect(added.result).toBe('Note 1 added.')
  expect(cleared.result).toBe('Note 1 cleared.')
  const ui = await $.ui.mount({ plugin: 'pr-assistant', surface: 'desktop', component: 'Pane', requestId: 'pr-walk', props: PANE })
  expect(await ui.find({ type: 'Text', text: '1 open' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/store/prDescriptions.ts:12' })).toBeDefined()
  expect(await ui.find({ key: 'note-1-ask' })).toBeUndefined()
  await ui.press({ key: 'note-2-ask' })
  await ui.press({ key: 'review' })
  await ui.unmount()
  expect(seen.filled).toEqual(['About note 2: ', 'Post the open notes as a pending review on #1091.'])
})

test('refuses what it cannot draw, and a call before a start', async ($, on) => {
  quiet(on)

  const early = await $.tool.call({ tool: 'mcp__pr-assistant__walk_goto', stop: 1 })
  await $.tool.call(START)
  const far = await $.tool.call({ tool: 'mcp__pr-assistant__walk_goto', stop: 4 })
  const huge = await $.tool.call({ tool: 'mcp__pr-assistant__walk_goto', stop: 1, diff: `@@ -1 +1 @@\n+${'x'.repeat(10_000)}` })
  const unknown = await $.tool.call({ tool: 'mcp__pr-assistant__walk_note', action: 'clear', id: 9 })

  expect(early.deny).toContain('Call walk_start first')
  expect(far.deny).toContain('from 1 to 3')
  expect(huge.deny).toContain('at most 10000')
  expect(unknown.deny).toContain('no note 9')
})

test('the panel says how to start before any walk, and the command opens it', async ($, on) => {
  const seen = quiet(on)

  const out = await $.command.run(PANEL)

  expect(out.text).toBe('PR walkthrough panel opened.')
  expect(seen.opened).toEqual(['pr-walk'])
  const ui = await $.ui.mount({ plugin: 'pr-assistant', surface: 'terminal', component: 'Pane', requestId: 'pr-walk', props: PANE })
  expect(await ui.find({ type: 'Text', text: /pr-assistant:pr walk/ })).toBeDefined()
  await ui.unmount()
})

test('wrapping up hides the controls and keeps the notes', async ($, on) => {
  quiet(on)
  await $.tool.call(START)
  await $.tool.call({ tool: 'mcp__pr-assistant__walk_note', kind: 'likely', text: 'A real one.' })

  const out = await $.tool.call({ tool: 'mcp__pr-assistant__walk_end' })

  expect(out.result).toBe('Walkthrough marked done; 1 open note left on the panel.')
  const ui = await $.ui.mount({ plugin: 'pr-assistant', surface: 'terminal', component: 'Pane', requestId: 'pr-walk', props: PANE })
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'done' })).toBeDefined()
  expect(await ui.find({ key: 'review' })).toBeDefined()
  await ui.unmount()
})
