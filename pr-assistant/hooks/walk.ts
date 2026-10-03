import type { Hunk, Note, NoteKind, Stop, StopKind, Walk } from '../types'

export const STOP_KINDS: StopKind[] = ['changed', 'new', 'removed', 'unchanged']
export const NOTE_KINDS: NoteKind[] = ['likely', 'check']
export const MAX_STOPS = 12
export const MAX_HUNK = 10_000

export type Step = { walk: Walk; reply: string } | { refusal: string }

type Args = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

export function start(args: Args): Step {
  const pr = (args.pr ?? {}) as Args
  const number = whole(pr.number)
  const title = text(pr.title)
  if (number === null || title === null) return { refusal: '`pr` needs a whole `number` and a `title`.' }
  const raw = Array.isArray(args.stops) ? (args.stops as Args[]) : []
  if (raw.length < 1 || raw.length > MAX_STOPS) return { refusal: `Give 1 to ${MAX_STOPS} stops.` }
  const stops: Stop[] = []
  for (const [i, s] of raw.entries()) {
    const title = text(s.title)
    const kind = (STOP_KINDS as unknown[]).includes(s.kind) ? (s.kind as StopKind) : null
    if (title === null || kind === null)
      return { refusal: `Stop ${i + 1} needs a \`title\` and a \`kind\` (${STOP_KINDS.join(', ')}).` }
    const files = Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === 'string') : []
    stops.push({ title, kind, files })
  }
  const url = text(pr.url)
  return {
    walk: {
      pr: { number, title, url: url !== null && /^https?:\/\//.test(url) ? url : null },
      summary: text(args.summary),
      stops,
      current: null,
      seen: [],
      hunk: null,
      notes: [],
      isDone: false,
    },
    reply: `Panel open on #${number} with ${stops.length} stops. Call walk_goto as you reach each one.`,
  }
}

export function goto(walk: Walk | null, args: Args): Step {
  if (walk === null) return { refusal: 'No walkthrough is running. Call walk_start first.' }
  const stop = whole(args.stop)
  if (stop === null || stop < 1 || stop > walk.stops.length)
    return { refusal: `\`stop\` is a number from 1 to ${walk.stops.length}.` }
  const source = typeof args.diff === 'string' && args.diff.trim() !== '' ? args.diff : null
  if (source !== null && source.length > MAX_HUNK)
    return { refusal: `The diff is ${source.length} characters; the panel shows at most ${MAX_HUNK}. Send the one hunk that matters.` }
  const hunk: Hunk | null = source === null ? null : { source, path: text(args.path) }
  const index = stop - 1
  return {
    walk: {
      ...walk,
      current: index,
      seen: walk.seen.includes(index) ? walk.seen : [...walk.seen, index],
      hunk,
      isDone: false,
    },
    reply: `Panel on stop ${stop} of ${walk.stops.length}.`,
  }
}

export function note(walk: Walk | null, args: Args): Step {
  if (walk === null) return { refusal: 'No walkthrough is running. Call walk_start first.' }
  const action = args.action ?? 'add'
  if (action === 'add') {
    const kind = (NOTE_KINDS as unknown[]).includes(args.kind) ? (args.kind as NoteKind) : null
    const body = text(args.text)
    if (kind === null || body === null)
      return { refusal: `A note needs a \`kind\` (${NOTE_KINDS.join(', ')}) and a \`text\`.` }
    const id = walk.notes.reduce((max, n) => Math.max(max, n.id), 0) + 1
    const line = whole(args.line)
    const added: Note = {
      id,
      kind,
      text: body,
      file: text(args.file),
      line: line !== null && line > 0 ? line : null,
      stop: walk.current === null ? null : walk.current + 1,
      isCleared: false,
    }
    return { walk: { ...walk, notes: [...walk.notes, added] }, reply: `Note ${id} added.` }
  }
  if (action !== 'clear' && action !== 'reopen') return { refusal: '`action` is add, clear or reopen.' }
  const id = whole(args.id)
  if (id === null || !walk.notes.some(n => n.id === id)) return { refusal: `There is no note ${String(args.id)}.` }
  const isCleared = action === 'clear'
  return {
    walk: { ...walk, notes: walk.notes.map(n => (n.id === id ? { ...n, isCleared } : n)) },
    reply: `Note ${id} ${isCleared ? 'cleared' : 'reopened'}.`,
  }
}

export function finish(walk: Walk | null): Step {
  if (walk === null) return { refusal: 'No walkthrough is running.' }
  const open = walk.notes.filter(n => !n.isCleared).length
  return {
    walk: { ...walk, current: null, hunk: null, isDone: true },
    reply: `Walkthrough marked done; ${open} open note${open === 1 ? '' : 's'} left on the panel.`,
  }
}

export const where = (n: Note): string | null =>
  n.file === null ? null : n.line === null ? n.file : `${n.file}:${n.line}`

export const clip = (s: string, room: number): string => (s.length <= room ? s : `${s.slice(0, Math.max(1, room - 1))}…`)
