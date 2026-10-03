import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note, StopKind } from '../types'
import { clip, finish, goto, MAX_HUNK, MAX_STOPS, note, NOTE_KINDS, start, STOP_KINDS, where, type Step } from './walk'

const walk = atom({ plugin: 'pr-assistant', key: 'walk' } as const, null)

const PANE = 'pr-walk'
const TITLE = 'PR walkthrough'

const KIND: Record<StopKind, { mark: string; color?: string }> = {
  changed: { mark: '~', color: 'yellow' },
  new: { mark: '+', color: 'green' },
  removed: { mark: '-', color: 'red' },
  unchanged: { mark: '·' },
}

const NOTE: Record<Note['kind'], { label: string; color: string }> = {
  likely: { label: 'likely', color: 'red' },
  check: { label: 'check me', color: 'yellow' },
}

const TOOLS = [
  {
    name: 'walk_start',
    description:
      'Open the PR walkthrough panel on a pull request and lay out its stops, in reading order. Replaces any walkthrough already on the panel. Call once, after you have read the PR and split it into stops.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: {
          type: 'object',
          properties: { number: { type: 'integer' }, title: { type: 'string' }, url: { type: 'string' } },
          required: ['number', 'title'],
        },
        summary: { type: 'string', description: 'One or two plain sentences: what the PR does.' },
        stops: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STOPS,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A few words, what happens at this stop.' },
              kind: { type: 'string', enum: STOP_KINDS },
              files: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'kind'],
          },
        },
      },
      required: ['pr', 'stops'],
    },
  },
  {
    name: 'walk_goto',
    description:
      'Move the panel to a stop (1-based) as you present it, with the one diff hunk that matters there. Call each time you present a stop, including when going back.',
    inputSchema: {
      type: 'object',
      properties: {
        stop: { type: 'integer', minimum: 1 },
        diff: {
          type: 'string',
          description: `Unified-diff hunks (each starting with an @@ header) for this stop, at most ${MAX_HUNK} characters. Leave out for an unchanged stop.`,
        },
        path: { type: 'string', description: 'The file the hunk is from, for highlighting.' },
      },
      required: ['stop'],
    },
  },
  {
    name: 'walk_note',
    description:
      'Add a note to the panel (a possible issue: kind "likely" for one you believe is real, "check" for one you could not confirm), or clear / reopen one by id once the question is settled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'clear', 'reopen'], default: 'add' },
        id: { type: 'integer', description: 'The note to clear or reopen.' },
        kind: { type: 'string', enum: NOTE_KINDS },
        text: { type: 'string', description: 'One or two plain sentences.' },
        file: { type: 'string' },
        line: { type: 'integer', description: 'A line in the PR head version of the file.' },
      },
    },
  },
  {
    name: 'walk_end',
    description: 'Mark the walkthrough done once you have given the wrap-up. The open notes stay on the panel.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const failed = ($: EngineInterface) => (err: unknown) =>
  $.ui.toast(`PR walkthrough: ${err instanceof Error ? err.message : String(err)}`)
const say = ($: EngineInterface, text: string) => () =>
  void $.prompt.submit({ text, asUser: true }).catch(failed($))
const draft = ($: EngineInterface, text: string) => () => void $.prompt.fill({ text }).catch(failed($))

async function apply($: EngineInterface, step: Step): Promise<{ result: string } | { deny: string }> {
  if ('refusal' in step) return { deny: step.refusal }
  await update($, walk, () => step.walk)
  return { result: step.reply }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      ...TOOLS.map(t => $.tool.register({ ...t, inputSchema: t.inputSchema as Record<string, unknown> })),
      $.command.register({ name: 'walk-panel', description: 'Open the PR walkthrough panel' }),
    ])
    return next(e)
  })

  on('command.run', { command: 'walk-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'PR walkthrough panel opened.' }
  })

  on('tool.call', { tool: 'mcp__pr-assistant__walk_start' }, async ($, e) => {
    const out = await apply($, start(e as Record<string, unknown>))
    if ('result' in out) await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    return out
  })

  on('tool.call', { tool: 'mcp__pr-assistant__walk_goto' }, async ($, e) =>
    apply($, goto(await read($, walk), e as Record<string, unknown>)),
  )

  on('tool.call', { tool: 'mcp__pr-assistant__walk_note' }, async ($, e) =>
    apply($, note(await read($, walk), e as Record<string, unknown>)),
  )

  on('tool.call', { tool: 'mcp__pr-assistant__walk_end' }, async $ => apply($, finish(await read($, walk))))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Code } = $.ui.resolve(e)
    const now = await read($, walk)
    const width = Math.max(24, e.props.bodyColumns)

    if (now === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No walkthrough yet.</Text>
          <Text dimColor>Start one with /lubbdubb:pr walk &lt;PR number&gt;.</Text>
        </Box>
      )
    }

    const heading = clip(`#${now.pr.number} ${now.pr.title}`, width)
    const open = now.notes.filter(n => !n.isCleared)
    const stop = now.current === null ? null : now.stops[now.current]
    const at = now.current ?? -1

    const header = (label: string, count?: string) => (
      <Box gap={1}>
        <Text bold>{label}</Text>
        {count !== undefined && <Text dimColor>{count}</Text>}
      </Box>
    )

    const noteRow = (n: Note) => {
      const place = where(n)
      return (
        <Box key={`note-${n.id}`} flexDirection="column">
          <Box gap={1}>
            <Text dimColor>{`${n.id}.`}</Text>
            {n.isCleared ? (
              <Text dimColor>cleared</Text>
            ) : (
              <Text bold color={NOTE[n.kind].color}>
                {NOTE[n.kind].label}
              </Text>
            )}
            {place !== null && <Text dimColor>{clip(place, Math.max(8, width - 16))}</Text>}
          </Box>
          <Text dimColor={n.isCleared} strikethrough={n.isCleared}>
            {n.text}
          </Text>
          {!n.isCleared && (
            <Button
              key={`note-${n.id}-ask`}
              plain
              dimColor
              label="Ask about this"
              onPress={draft($, `About note ${n.id}: `)}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {now.pr.url !== null ? (
            <Text bold>
              <Link href={now.pr.url} label={heading} />
            </Text>
          ) : (
            <Text bold>{heading}</Text>
          )}
          {now.summary !== null && <Text dimColor>{now.summary}</Text>}
        </Box>

        <Box flexDirection="column">
          {header('Stops', now.isDone ? 'done' : now.current === null ? `${now.stops.length}` : `${at + 1} of ${now.stops.length}`)}
          {now.stops.map((s, i) => {
            const isHere = i === at
            const seen = now.seen.includes(i)
            return (
              <Box key={`stop-${i + 1}`} gap={1}>
                <Text color={isHere ? 'cyan' : undefined} dimColor={!isHere && !seen}>
                  {isHere ? '▶' : seen ? '✓' : ' '}
                </Text>
                <Text color={KIND[s.kind].color} dimColor={KIND[s.kind].color === undefined}>
                  {KIND[s.kind].mark}
                </Text>
                <Button
                  key={`stop-${i + 1}-go`}
                  plain
                  label={clip(`${i + 1}. ${s.title}`, Math.max(8, width - 6))}
                  onPress={say($, `Go to stop ${i + 1}.`)}
                />
              </Box>
            )
          })}
        </Box>

        {stop !== undefined && stop !== null && (
          <Box flexDirection="column">
            {header(`Stop ${at + 1}`, stop.kind)}
            {stop.files.map((f, i) => (
              <Text key={`file-${i}`} dimColor>
                {clip(f, width)}
              </Text>
            ))}
            {now.hunk !== null && (
              <Code
                source={now.hunk.source}
                format="diff"
                {...(now.hunk.path !== null ? { path: now.hunk.path } : {})}
              />
            )}
          </Box>
        )}

        {!now.isDone && (
          <Box gap={2}>
            <Button key="back" label="Back" onPress={say($, 'Back.')} />
            <Button key="next" variant="primary" label="Next" onPress={say($, 'Next.')} />
            <Button key="done" label="Wrap up" onPress={say($, 'Done, wrap up.')} />
          </Box>
        )}

        <Box flexDirection="column" gap={1}>
          {header('Notes', `${open.length} open`)}
          {now.notes.length === 0 && <Text dimColor>Nothing flagged yet.</Text>}
          {now.notes.map(noteRow)}
          {open.length > 0 && (
            <Button
              key="review"
              label="Post open notes as a review"
              onPress={draft($, `Post the open notes as a pending review on #${now.pr.number}.`)}
            />
          )}
        </Box>
      </Box>
    )
  })
}
