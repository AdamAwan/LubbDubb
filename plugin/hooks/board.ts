import type { Agent, Board, Feature, Notice, Pr, PrTone, Queued } from '../types'

const LIVE = new Set(['starting', 'running', 'waiting'])

type Ask = { id: string; kind: string; title: string; standing: boolean; focusRank: number; urgency?: string }

type WirePr = {
  number: number
  title: string
  ciStatus: 'passing' | 'failing' | 'pending' | 'unknown'
  unresolvedComments: unknown[]
  approved?: boolean
  mergeableState?: 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown'
  state?: 'open' | 'merged' | 'closed'
}

export type StateReply = {
  asks?: Ask[]
  control?: { paused: boolean; cap?: number }
  agents?: { id: string; taskId: string; status: string; costUsd: number | null; startedAt: string }[]
  tasks?: { id: string; title: string }[]
  upcoming?: { items: { origin: string; title: string; status: string }[] } | null
  world?: { pullRequests: WirePr[] }
  refUrls?: Record<string, string>
}

export type FeaturesReply = {
  features?: {
    number: number
    title: string
    counts: { delivered: number; inFlight: number; settled: number; total: number }
    briefing: { blockingTotal: number }
  }[]
}

export const clip = (text: string, max: number): string => {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

export const safeHref = (url: string | undefined): string | null =>
  url !== undefined && /^https:\/\/[!-~]+$/.test(url) && !url.includes('@') && url.length <= 2048 ? url : null

export function prState(pr: WirePr): { state: string; tone: PrTone } {
  const threads = pr.unresolvedComments.length
  if (pr.mergeableState === 'dirty') return { state: 'conflicts', tone: 'bad' }
  if (pr.ciStatus === 'failing') return { state: 'CI failing', tone: 'bad' }
  if (threads > 0) return { state: `${threads} ${threads === 1 ? 'thread' : 'threads'}`, tone: 'warn' }
  if (pr.ciStatus === 'pending') return { state: 'CI running', tone: 'quiet' }
  if (pr.approved && pr.mergeableState !== 'blocked') return { state: 'ready to merge', tone: 'good' }
  if (pr.mergeableState === 'behind') return { state: 'behind base', tone: 'warn' }
  return { state: 'in review', tone: 'quiet' }
}

export function toBoard(state: StateReply, board: FeaturesReply | null): Board {
  const titles = new Map((state.tasks ?? []).map(t => [t.id, t.title]))
  const notices: Notice[] = (state.asks ?? [])
    .filter(a => a.standing)
    .sort((a, b) => a.focusRank - b.focusRank)
    .map(a => ({ id: a.id, kind: a.kind.replace(/_/g, ' '), title: clip(a.title, 80), urgent: a.urgency === 'now' }))
  const features: Feature[] = (board?.features ?? [])
    .map(f => ({
      number: f.number,
      title: f.title,
      delivered: f.counts.delivered + f.counts.settled,
      inFlight: f.counts.inFlight,
      blocked: f.briefing.blockingTotal,
      total: f.counts.total,
    }))
    .filter(f => f.total > 0 && f.delivered < f.total)
  const prs: Pr[] = (state.world?.pullRequests ?? [])
    .filter(pr => (pr.state ?? 'open') === 'open')
    .map(pr => ({
      number: pr.number,
      title: pr.title,
      ...prState(pr),
      url: safeHref(state.refUrls?.[`pr:${pr.number}`] ?? state.refUrls?.[`#${pr.number}`]),
    }))
  const agents: Agent[] = (state.agents ?? [])
    .filter(a => LIVE.has(a.status))
    .map(a => ({
      id: a.id,
      title: titles.get(a.taskId) ?? a.taskId,
      isWaiting: a.status === 'waiting',
      costUsd: a.costUsd ?? 0,
      startedAt: a.startedAt,
    }))
  const upNext: Queued[] = (state.upcoming?.items ?? []).map(q => ({ origin: q.origin, title: q.title, status: q.status }))
  return {
    notices,
    features,
    prs,
    agents,
    upNext,
    paused: state.control?.paused ?? false,
    cap: state.control?.cap ?? 0,
  }
}

export type Part = { text: string; tone?: PrTone }

export function bandParts(board: Board): Part[] {
  const count = board.notices.length
  const urgent = board.notices.filter(n => n.urgent).length
  const attention = board.prs.filter(pr => pr.tone === 'bad' || pr.tone === 'warn').length
  const parts: (Part | false)[] = [
    board.paused && { text: 'fleet paused', tone: 'warn' },
    { text: `${board.agents.length}/${board.cap} agents` },
    count > 0
      ? { text: `${count} ${count === 1 ? 'ask' : 'asks'}${urgent > 0 ? ` (${urgent} blocking)` : ''}`, tone: urgent > 0 ? 'bad' : 'warn' }
      : { text: 'no asks' },
    attention > 0 && { text: `${attention} ${attention === 1 ? 'PR needs' : 'PRs need'} attention`, tone: 'warn' },
  ]
  return parts.filter((p): p is Part => p !== false)
}

export function summary(board: Board): string {
  return bandParts(board)
    .map(p => p.text)
    .join(' · ')
}

export function fresh(before: Board | null, after: Board): Notice[] {
  if (before === null) return []
  const seen = new Set(before.notices.map(n => n.id))
  return after.notices.filter(n => !seen.has(n.id))
}
