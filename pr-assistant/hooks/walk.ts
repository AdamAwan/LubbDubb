import type { EdgeState, Hunk, MapNode, MapStatus, MapStep, Note, NoteKind, PrMap, Slice, Stop, StopKind, Walk } from '../types'

export const STOP_KINDS: StopKind[] = ['changed', 'new', 'removed', 'unchanged']
export const NOTE_KINDS: NoteKind[] = ['likely', 'check']
export const MAX_STOPS = 12
export const MAX_HUNK = 10_000

const MAP_STATUSES: MapStatus[] = ['changed', 'new', 'removed', 'path', 'outside', 'test', 'doc']
const EDGE_STATES: EdgeState[] = ['normal', 'changed', 'blocked', 'ghost', 'absent']

export type Step = { walk: Walk; reply: string } | { refusal: string }

type Args = Record<string, unknown>

export const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const oneOf = <T,>(list: readonly T[], v: unknown): T | null => ((list as unknown[]).includes(v) ? (v as T) : null)

type DiffHunk = { path: string; old: [number, number]; new: [number, number]; source: string }

export function readDiff(raw: string): DiffHunk[] {
  const out: DiffHunk[] = []
  let from: string | null = null
  let to: string | null = null
  let at: DiffHunk | null = null
  const side = (l: string) => {
    const p = l.slice(4).replace(/\t.*$/, '').trim()
    return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
  }
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      at = null
      from = to = null
    } else if (at === null && line.startsWith('--- ')) from = side(line)
    else if (at === null && line.startsWith('+++ ')) to = side(line)
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      const path = to ?? from
      at = null
      if (m === null || path === null) continue
      const span = (a?: string, b?: string): [number, number] => [Number(a), b === undefined ? 1 : Number(b)]
      at = { path, old: span(m[1], m[2]), new: span(m[3], m[4]), source: `${line}\n` }
      out.push(at)
    } else if (at !== null && /^[ +\-\\]/.test(line)) at.source += `${line}\n`
    else at = null
  }
  return out
}

const covers = ([start, length]: [number, number], line: number) => line >= start && line < start + Math.max(1, length)

function cut(diff: DiffHunk[], refs: string[]): Hunk[] | string {
  const chosen = new Set<DiffHunk>()
  for (const ref of refs) {
    const m = /^(.*?)(?::(\d+))?$/.exec(ref.trim())!
    const line = m[2] === undefined ? null : Number(m[2])
    const inFile = diff.filter(h => h.path === m[1] || h.path.endsWith(`/${m[1]}`))
    const onNew = line === null ? inFile : inFile.filter(h => covers(h.new, line))
    const found = onNew.length > 0 || line === null ? onNew : inFile.filter(h => covers(h.old, line))
    if (found.length === 0) return `\`${ref}\` is in no hunk of the diff`
    for (const h of found) chosen.add(h)
  }
  const hunks: Hunk[] = []
  for (const h of diff.filter(d => chosen.has(d))) {
    const last = hunks[hunks.length - 1]
    if (last !== undefined && last.path === h.path) last.source += h.source
    else hunks.push({ source: h.source, path: h.path })
  }
  const big = hunks.find(h => h.source.length > MAX_HUNK)
  if (big !== undefined)
    return `its hunks in ${big.path} come to ${big.source.length} characters; the panel shows at most ${MAX_HUNK}. Name single lines instead`
  return hunks
}

export function start(args: Args, map: PrMap | null = null, diff: DiffHunk[] | null = null): Step {
  const pr = (args.pr ?? {}) as Args
  const number = whole(pr.number)
  const title = text(pr.title)
  if (number === null || title === null) return { refusal: '`pr` needs a whole `number` and a `title`.' }
  const raw = Array.isArray(args.stops) ? (args.stops as Args[]) : []
  if (raw.length < 1 || raw.length > MAX_STOPS) return { refusal: `Give 1 to ${MAX_STOPS} stops.` }
  const stops: Stop[] = []
  for (const [i, s] of raw.entries()) {
    const title = text(s.title)
    const kind = oneOf(STOP_KINDS, s.kind)
    if (title === null || kind === null)
      return { refusal: `Stop ${i + 1} needs a \`title\` and a \`kind\` (${STOP_KINDS.join(', ')}).` }
    const files = strings(s.files)
    const steps = Array.isArray(s.steps) ? s.steps.map(whole) : []
    if (steps.length > 0 && map === null) return { refusal: `Stop ${i + 1} names map \`steps\` but no \`map\` was given.` }
    if (map !== null && steps.some(n => n === null || n < 1 || n > map.steps.length))
      return { refusal: `Stop ${i + 1}: \`steps\` are map step numbers from 1 to ${map.steps.length}.` }
    const refs = strings(s.hunks)
    if (refs.length > 0 && diff === null) return { refusal: `Stop ${i + 1} names \`hunks\` but no \`diff\` was given.` }
    const hunks = diff === null ? [] : cut(diff, refs)
    if (typeof hunks === 'string') return { refusal: `Stop ${i + 1}: ${hunks}.` }
    stops.push({ title, kind, files, steps: steps as number[], hunks })
  }
  const url = text(pr.url)
  return {
    walk: {
      pr: { number, title, url: url !== null && /^https?:\/\//.test(url) ? url : null },
      summary: text(args.summary),
      stops,
      current: null,
      seen: [],
      hunks: [],
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
  const index = stop - 1
  const hunks: Hunk[] = source === null ? walk.stops[index]!.hunks : [{ source, path: text(args.path) }]
  return {
    walk: {
      ...walk,
      current: index,
      seen: walk.seen.includes(index) ? walk.seen : [...walk.seen, index],
      hunks,
      isDone: false,
      views: call === undefined ? walk.views : { ...walk.views, [call]: { stop: index, hunks } },
    },
    reply: `Panel on stop ${stop} of ${walk.stops.length}.`,
  }
}

export function note(walk: Walk | null, args: Args): Step {
  if (walk === null) return { refusal: 'No walkthrough is running. Call walk_start first.' }
  const action = args.action ?? 'add'
  if (action === 'add') {
    const kind = oneOf(NOTE_KINDS, args.kind)
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
    walk: { ...walk, current: null, hunks: [], isDone: true },
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
    status: oneOf(MAP_STATUSES, n.status) ?? 'path',
    note: text(n.note),
    before: text(n.before),
    after: text(n.after),
  }))
  const edges = list(d.edges).map(e => ({
    from: text(e.from) ?? '',
    to: text(e.to) ?? '',
    label: text(e.label),
    before: oneOf(EDGE_STATES, e.before) ?? 'normal',
    after: oneOf(EDGE_STATES, e.after) ?? (e.changed === true ? 'changed' : 'normal'),
  }))
  const steps: MapStep[] = list(d.steps).map(s => ({
    title: text(s.title) ?? '',
    nodes: strings(s.nodes),
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
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const ids = new Set(chosen.flatMap(s => s.nodes).filter(id => byId.has(id)))
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
