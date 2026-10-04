import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feature, PrTone } from '../types'
import { bandParts, clip, fresh, summary, toBoard, type FeaturesReply, type StateReply } from './board'
import { LOGO_COLUMNS, LOGO_FRAMES, LOGO_ROWS, logoCells, logoSvg } from './logo'

const board = atom({ plugin: 'lubbdubb', key: 'board' } as const, null)
const isHidden = atom({ plugin: 'lubbdubb', key: 'isHidden' } as const, false)

const POLL_MS = 15_000
const PANE = 'lubbdubb'
const TITLE = 'LubbDubb'
const BAR = 10
const LOGO_KEY = 'logo'
const BEAT_MS = 100
const LOGO_MIN_WIDTH = 40

let beat = 0

const TONE: Record<PrTone, { mark: string; color?: string }> = {
  good: { mark: '●', color: 'green' },
  warn: { mark: '●', color: 'yellow' },
  bad: { mark: '●', color: 'red' },
  quiet: { mark: '○' },
}

type Where = { url: string; tokenFile: string }

async function token($: EngineInterface, where: Where): Promise<string | undefined> {
  const fromEnv = await $.env.get('LUBBDUBB_TOKEN')
  if (fromEnv) return fromEnv.trim()
  try {
    return (await $.fs.read(where.tokenFile)).trim()
  } catch {
    return undefined
  }
}

async function poll($: EngineInterface, where: Where): Promise<void> {
  const bearer = await token($, where)
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {}
  const [reply, features] = await Promise.all([
    $.http.fetch(`${where.url}/api/state?sections=asks,control,fleet,queue,goals`, { headers }).catch(() => null),
    $.http.fetch(`${where.url}/api/features`, { headers }).catch(() => null),
  ])
  if (reply === null || !reply.ok) {
    await update($, board, () => null)
    return
  }
  const after = toBoard(
    JSON.parse(reply.text) as StateReply,
    features?.ok ? (JSON.parse(features.text) as FeaturesReply) : null,
  )
  const before = await read($, board)
  for (const notice of fresh(before, after)) $.ui.toast(`LubbDubb: ${notice.title}`)
  await update($, board, () => after)
}

async function setPaused($: EngineInterface, where: Where, paused: boolean): Promise<void> {
  const bearer = await token($, where)
  const reply = await $.http.fetch(`${where.url}/api/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ paused }),
  })
  if (!reply.ok) throw new Error(`LubbDubb refused (${reply.status})`)
  await poll($, where)
}

async function act($: EngineInterface, done: string, work: () => Promise<unknown>): Promise<void> {
  try {
    const result = await work()
    if (typeof result === 'object' && result !== null && 'isFilled' in result && result.isFilled === false) {
      $.ui.toast('LubbDubb: the prompt box did not take it')
      return
    }
    $.ui.toast(done)
  } catch (err) {
    $.ui.toast(`LubbDubb: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const ago = (since: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000))
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`
}

async function heartbeat($: EngineInterface): Promise<void> {
  if ((await read($, board)) === null) return
  beat = (beat + 1) % LOGO_FRAMES
  await $.ui.blit({ requestId: PANE, key: LOGO_KEY, columns: LOGO_COLUMNS, rows: LOGO_ROWS, cells: logoCells(beat) })
}

const draft = ($: EngineInterface, text: string) => () => void act($, 'Added to the prompt box', () => $.prompt.fill({ text }))

export const register: Register = (on, options) => {
  const where: Where = {
    url: String(options.url ?? 'http://127.0.0.1:4300').replace(/\/$/, ''),
    tokenFile: String(options.tokenFile ?? '.lubbdubb/cockpit-token'),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'List what LubbDubb is waiting on you for' })
    await $.command.register({ name: 'panel', description: 'Open the LubbDubb panel' })
    void poll($, where)
    $.clock.every(POLL_MS, () => void poll($, where))
    $.clock.every(BEAT_MS, () => void heartbeat($))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await poll($, where)
    await update($, isHidden, () => false)
    const now = await read($, board)
    if (now === null) return { text: `LubbDubb is not answering at ${where.url}.` }
    if (now.notices.length === 0) {
      return { text: now.paused ? 'Nothing waiting on you. The fleet is paused.' : 'Nothing waiting on you.' }
    }
    const lines = now.notices.map((n, i) => `${i + 1}. ${n.kind}: ${n.title}`)
    const after = 'Work through them one at a time with /lubbdubb:next, or in the cockpit.'
    return { text: [summary(now), ...lines, '', after].join('\n') }
  })

  on('command.run', { command: 'panel' }, async $ => {
    await poll($, where)
    await update($, isHidden, () => false)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'LubbDubb panel opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, board)
    if (e.props.hasSurvey || now === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Box key="band" borderStyle="round" borderDimColor paddingX={1} gap={1}>
          <Text color={now.paused ? 'yellow' : 'green'}>{now.paused ? '■' : '●'}</Text>
          <Text bold>LubbDubb</Text>
          {bandParts(now).map((part, i) => {
            const color = part.tone === undefined ? undefined : TONE[part.tone].color
            return (
              <Text key={`part-${i}`} color={color} dimColor={color === undefined}>
                {`${i === 0 ? '' : '· '}${part.text}`}
              </Text>
            )
          })}
          {now.notices.length > 0 && (
            <Button key="next" plain label="Work through asks" onPress={draft($, '/lubbdubb:next')} />
          )}
          <Button
            key="open-panel"
            plain
            dimColor
            label="Open panel"
            onPress={() => void act($, 'LubbDubb panel opened', () => $.ui.open({ id: PANE, title: TITLE }))}
          />
          <Button key="hide" plain dimColor label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {theirs}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const now = await read($, board)
    const width = Math.max(24, e.props.bodyColumns)

    const logo = (alive: boolean) => {
      if (width < LOGO_MIN_WIDTH) return null
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        return <Raster key={LOGO_KEY} columns={LOGO_COLUMNS} rows={LOGO_ROWS} cells={logoCells(alive ? beat : null)} />
      }
      const { Svg } = $.ui.resolve(e)
      return <Svg source={logoSvg(alive)} alt="LubbDubb" width={44} height={44} isInteractive />
    }
    const wordmark = (
      <Text bold>
        Lubb<Text color="red">Dubb</Text>
      </Text>
    )

    if (now === null) {
      return (
        <Box gap={2} alignItems="center">
          {logo(false)}
          <Text dimColor>{`LubbDubb is not answering at ${where.url}.`}</Text>
        </Box>
      )
    }

    const header = (label: string, count: string, action?: unknown) => (
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold>{label}</Text>
          <Text dimColor>{count}</Text>
        </Box>
        {action}
      </Box>
    )

    const row = (r: {
      id: string
      mark: string
      markColor?: string
      title: string
      meta: string
      metaColor?: string
      onPress?: () => void
      href?: string | null
      action?: { label: string; onPress: () => void }
    }) => {
      const room = Math.max(8, width - r.meta.length - (r.action ? r.action.label.length + 1 : 0) - 4)
      const label = clip(r.title, room)
      return (
        <Box key={r.id} justifyContent="space-between">
          <Box gap={1}>
            <Text color={r.markColor} dimColor={r.markColor === undefined}>
              {r.mark}
            </Text>
            {r.href ? (
              <Text>
                <Link href={r.href} label={label} />
              </Text>
            ) : r.onPress ? (
              <Button key={`${r.id}-go`} plain label={label} onPress={r.onPress} />
            ) : (
              <Text>{label}</Text>
            )}
          </Box>
          <Box gap={1}>
            <Text color={r.metaColor} dimColor={r.metaColor === undefined}>
              {r.meta}
            </Text>
            {r.action && <Button key={`${r.id}-action`} plain dimColor label={r.action.label} onPress={r.action.onPress} />}
          </Box>
        </Box>
      )
    }

    const featureRow = (f: Feature) => {
      const filled = Math.round((f.delivered / f.total) * BAR)
      const going = Math.min(BAR - filled, Math.round((f.inFlight / f.total) * BAR))
      const tally = `${f.delivered}/${f.total}`
      const room = Math.max(8, width - BAR - tally.length - 5)
      return (
        <Box key={`feature-${f.number}`} justifyContent="space-between">
          <Box gap={1}>
            <Text color={f.blocked > 0 ? 'red' : undefined} dimColor={f.blocked === 0}>
              {f.blocked > 0 ? '!' : '·'}
            </Text>
            <Button
              key={`feature-${f.number}-ask`}
              plain
              label={clip(f.title, room)}
              onPress={draft($, `/lubbdubb:feature ${f.number}`)}
            />
          </Box>
          <Box gap={1}>
            <Text>
              <Text color="green">{'━'.repeat(filled)}</Text>
              <Text color="yellow">{'━'.repeat(going)}</Text>
              <Text dimColor>{'─'.repeat(BAR - filled - going)}</Text>
            </Text>
            <Text dimColor>{tally}</Text>
          </Box>
        </Box>
      )
    }

    const waiting = now.agents.filter(a => a.isWaiting).length
    const running = now.agents.length - waiting

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2} alignItems="center">
          {logo(true)}
          <Box flexDirection="column" flexGrow={1}>
            {wordmark}
            <Box justifyContent="space-between">
              <Box gap={1}>
                <Text color={now.paused ? 'yellow' : 'green'}>{now.paused ? '■' : '●'}</Text>
                <Text bold>{now.paused ? 'Paused' : 'Running'}</Text>
                <Text dimColor>{`· ${now.agents.length} of ${now.cap} slots`}</Text>
              </Box>
              <Button
                key="pause"
                hotkey="p"
                label={now.paused ? 'Resume' : 'Pause'}
                onPress={() =>
                  void act($, now.paused ? 'Fleet resumed' : 'Fleet paused', () => setPaused($, where, !now.paused))
                }
              />
            </Box>
          </Box>
        </Box>

        <Box flexDirection="column">
          {header(
            'Needs you',
            String(now.notices.length),
            now.notices.length > 0 && (
              <Button
                key="next"
                hotkey="n"
                variant="primary"
                label="Work through asks"
                onPress={draft($, '/lubbdubb:next')}
              />
            ),
          )}
          {now.notices.length === 0 && <Text dimColor>Nothing waiting on you.</Text>}
          {now.notices.slice(0, 5).map(n =>
            row({
              id: `ask-${n.id}`,
              mark: n.urgent ? '!' : '·',
              markColor: n.urgent ? 'red' : undefined,
              title: n.title,
              meta: n.kind,
              onPress: draft($, `/lubbdubb:next ${n.id}`),
            }),
          )}
          {now.notices.length > 5 && <Text dimColor>{`  +${now.notices.length - 5} more`}</Text>}
        </Box>

        {now.features.length > 0 && (
          <Box flexDirection="column">
            {header('Features', `${now.features.length} in progress`)}
            {now.features.slice(0, 5).map(featureRow)}
          </Box>
        )}

        <Box flexDirection="column">
          {header('Pull requests', String(now.prs.length))}
          {now.prs.length === 0 && <Text dimColor>No open pull requests.</Text>}
          {now.prs.slice(0, 6).map(pr =>
            row({
              id: `pr-${pr.number}`,
              mark: TONE[pr.tone].mark,
              markColor: TONE[pr.tone].color,
              title: `#${pr.number} ${pr.title}`,
              meta: pr.state,
              metaColor: TONE[pr.tone].color,
              href: pr.url,
              action: { label: 'Review With Me', onPress: draft($, `/pr-assistant:pr walk ${pr.number}`) },
            }),
          )}
          {now.prs.length > 6 && <Text dimColor>{`  +${now.prs.length - 6} more`}</Text>}
        </Box>

        <Box flexDirection="column">
          {header('Fleet', waiting > 0 ? `${running} running · ${waiting} waiting` : `${running} running`)}
          {now.agents.length === 0 && <Text dimColor>No agents out.</Text>}
          {now.agents.map(a =>
            row({
              id: `agent-${a.id}`,
              mark: a.isWaiting ? '○' : '●',
              markColor: a.isWaiting ? 'yellow' : 'green',
              title: a.title,
              meta: `${ago(a.startedAt)}  $${a.costUsd.toFixed(2)}`,
            }),
          )}
        </Box>

        <Box flexDirection="column">
          {header('Up next', String(now.upNext.length))}
          {now.upNext.length === 0 && <Text dimColor>Queue is empty.</Text>}
          {now.upNext.slice(0, 5).map(q => row({ id: `q-${q.origin}`, mark: '·', title: q.title, meta: q.origin }))}
        </Box>
      </Box>
    )
  })
}
