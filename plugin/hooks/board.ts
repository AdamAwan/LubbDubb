import type { Board, Notice } from '../types'

type Escalation = { id: string; prompt: string }
type Proposal = { id: string; kind: string; ref: string; status: string }
type HumanTask = { id: string; title: string; status: string }

export type StateReply = {
  escalations?: Escalation[]
  proposals?: Proposal[]
  humanTasks?: HumanTask[]
  control?: { paused: boolean }
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 80)

export function toBoard(state: StateReply): Board {
  const notices: Notice[] = [
    ...(state.escalations ?? []).map(e => ({ id: `q:${e.id}`, kind: 'question' as const, title: firstLine(e.prompt) })),
    ...(state.proposals ?? [])
      .filter(p => p.status === 'pending')
      .map(p => ({ id: `p:${p.id}`, kind: 'approval' as const, title: `${p.kind.replace(/_/g, ' ')} on ${p.ref}` })),
    ...(state.humanTasks ?? [])
      .filter(t => t.status === 'open')
      .map(t => ({ id: `t:${t.id}`, kind: 'task' as const, title: firstLine(t.title) })),
  ]
  return { notices, paused: state.control?.paused ?? false }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function summary(board: Board): string {
  const count = (kind: Notice['kind']) => board.notices.filter(n => n.kind === kind).length
  const parts = [
    count('question') > 0 && plural(count('question'), 'question', 'questions'),
    count('approval') > 0 && plural(count('approval'), 'to approve', 'to approve'),
    count('task') > 0 && plural(count('task'), 'task for you', 'tasks for you'),
    board.paused && 'fleet paused',
  ].filter((p): p is string => typeof p === 'string')
  return parts.join(' · ')
}

export function fresh(before: Board | null, after: Board): Notice[] {
  if (before === null) return []
  const seen = new Set(before.notices.map(n => n.id))
  return after.notices.filter(n => !seen.has(n.id))
}
