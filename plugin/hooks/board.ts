import type { Board, Notice } from '../types'

type Ask = { id: string; kind: string; title: string; standing: boolean; focusRank: number }

export type StateReply = {
  asks?: Ask[]
  control?: { paused: boolean }
}

const clip = (text: string, max: number): string => {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function toBoard(state: StateReply): Board {
  const notices: Notice[] = (state.asks ?? [])
    .filter(a => a.standing)
    .sort((a, b) => a.focusRank - b.focusRank)
    .map(a => ({ id: a.id, kind: a.kind.replace(/_/g, ' '), title: clip(a.title, 80) }))
  return { notices, paused: state.control?.paused ?? false }
}

export function summary(board: Board): string {
  const count = board.notices.length
  const head = board.notices[0]
  const parts = [
    count > 0 && `${count} ${count === 1 ? 'ask' : 'asks'}`,
    head !== undefined && `next: ${clip(head.title, 60)}`,
    board.paused && 'fleet paused',
  ].filter((p): p is string => typeof p === 'string')
  return parts.join(' · ')
}

export function fresh(before: Board | null, after: Board): Notice[] {
  if (before === null) return []
  const seen = new Set(before.notices.map(n => n.id))
  return after.notices.filter(n => !seen.has(n.id))
}
