import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { fresh, summary, toBoard, type StateReply } from './board'

const board = atom({ plugin: 'lubbdubb', key: 'board' } as const, null)
const isHidden = atom({ plugin: 'lubbdubb', key: 'isHidden' } as const, false)

const POLL_MS = 30_000

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
  let reply = null
  try {
    reply = await $.http.fetch(`${where.url}/api/state?sections=asks,control`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  } catch {
    reply = null
  }
  if (reply === null || !reply.ok) {
    await update($, board, () => null)
    return
  }
  const after = toBoard(JSON.parse(reply.text) as StateReply)
  const before = await read($, board)
  for (const notice of fresh(before, after)) $.ui.toast(`LubbDubb: ${notice.title}`)
  await update($, board, () => after)
}

export const register: Register = (on, options) => {
  const where: Where = {
    url: String(options.url ?? 'http://127.0.0.1:4300').replace(/\/$/, ''),
    tokenFile: String(options.tokenFile ?? '.lubbdubb/cockpit-token'),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'List what LubbDubb is waiting on you for' })
    void poll($, where)
    $.clock.every(POLL_MS, () => void poll($, where))
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, board)
    if (e.props.hasSurvey || now === null || (await read($, isHidden))) return next(e)
    const line = summary(now)
    if (line === '') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>{`LubbDubb · ${line}${now.notices.length > 0 ? ' · /lubbdubb:next' : ''} `}</Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
