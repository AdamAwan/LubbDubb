import type { EdgeState, Hunk, MapNode, MapStatus, MapStep, Note, NoteKind, PrMap, Slice, Stop, StopKind, Walk } from '../types'

export const STOP_KINDS: StopKind[] = ['changed', 'new', 'removed', 'unchanged']
export const NOTE_KINDS: NoteKind[] = ['likely', 'check']
export const MAX_STOPS = 12
export const MAX_HUNK = 10_000

const MAP_STATUSES: MapStatus[] = ['changed', 'new', 'removed', 'path', 'outside', 'test', 'doc']
const EDGE_STATES: EdgeState[] = ['normal', 'changed', 'blocked', 'ghost', 'absent']

export type Step = { walk: Walk; reply: string } | { refusal: string }

type Args = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

export function start(args: Args, map: PrMap | null = null): Step {
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
    const steps = Array.isArray(s.steps) ? s.steps.map(whole) : []
    if (steps.length > 0 && map === null) return { refusal: `Stop ${i + 1} names map \`steps\` but no \`map\` was given.` }
    if (map !== null && steps.some(n => n === null || n < 1 || n > map.steps.length))
      return { refusal: `Stop ${i + 1}: \`steps\` are map step numbers from 1 to ${map.steps.length}.` }
    stops.push({ title, kind, files, steps: steps as number[] })
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
      map,
      views: {},
    },
    reply: `Panel open on #${number} with ${stops.length} stops${map === null ? '' : ', the map loaded'}. Call walk_goto as you reach each one.`,
  }
}

export function goto(walk: Walk | null, args: Args, call?: string): Step {
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
      views: call === undefined ? walk.views : { ...walk.views, [call]: index },
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

export const plain = (s: string): string => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')

export function readMap(raw: unknown): PrMap | string {
  const d = (raw ?? {}) as Args
  const list = (v: unknown): Args[] => (Array.isArray(v) ? (v as Args[]) : [])
  const columns = list(d.columns).map(c => ({ id: text(c.id) ?? '', label: text(c.label) ?? '' }))
  const nodes: MapNode[] = list(d.nodes).map(n => ({
    id: text(n.id) ?? '',
    title: text(n.title) ?? '',
    file: text(n.file),
    column: text(n.column) ?? '',
    status: (MAP_STATUSES as unknown[]).includes(n.status) ? (n.status as MapStatus) : 'path',
    note: text(n.note),
    before: text(n.before),
    after: text(n.after),
  }))
  const state = (v: unknown, fallback: EdgeState): EdgeState =>
    (EDGE_STATES as unknown[]).includes(v) ? (v as EdgeState) : fallback
  const edges = list(d.edges).map(e => ({
    from: text(e.from) ?? '',
    to: text(e.to) ?? '',
    label: text(e.label),
    before: state(e.before, 'normal'),
    after: state(e.after, e.changed === true ? 'changed' : 'normal'),
  }))
  const steps: MapStep[] = list(d.steps).map(s => ({
    title: text(s.title) ?? '',
    nodes: Array.isArray(s.nodes) ? s.nodes.filter((x): x is string => typeof x === 'string') : [],
    text: text(s.text),
    before: text(s.before),
    after: text(s.after),
  }))
  if (columns.length === 0 || nodes.length === 0 || steps.length === 0)
    return 'it has no columns, nodes or steps. Pass the JSON file the map job built.'
  return { columns, nodes, edges, steps }
}

export function slice(map: PrMap, steps: number[]): Slice | null {
  const chosen = steps.flatMap(n => (map.steps[n - 1] === undefined ? [] : [{ ...map.steps[n - 1]!, n }]))
  if (chosen.length === 0) return null
  const ids = new Set(chosen.flatMap(s => s.nodes))
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  return {
    columns: map.columns
      .map(c => ({ label: c.label, nodes: map.nodes.filter(n => n.column === c.id && ids.has(n.id)) }))
      .filter(c => c.nodes.length > 0),
    edges: map.edges
      .filter(e => ids.has(e.from) && ids.has(e.to))
      .map(e => ({ ...e, fromTitle: byId.get(e.from)!.title, toTitle: byId.get(e.to)!.title })),
    steps: chosen,
  }
}
