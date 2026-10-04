export type StopKind = 'changed' | 'new' | 'removed' | 'unchanged'

export type Stop = { title: string; kind: StopKind; files: string[]; steps: number[] }

export type MapStatus = 'changed' | 'new' | 'removed' | 'path' | 'outside' | 'test' | 'doc'

export type EdgeState = 'normal' | 'changed' | 'blocked' | 'ghost' | 'absent'

export type MapNode = {
  id: string
  title: string
  file: string | null
  column: string
  status: MapStatus
  note: string | null
  before: string | null
  after: string | null
}

export type MapEdge = { from: string; to: string; label: string | null; before: EdgeState; after: EdgeState }

export type MapStep = {
  title: string
  nodes: string[]
  text: string | null
  before: string | null
  after: string | null
}

export type PrMap = {
  columns: { id: string; label: string }[]
  nodes: MapNode[]
  edges: MapEdge[]
  steps: MapStep[]
}

export type Slice = {
  columns: { label: string; nodes: MapNode[] }[]
  edges: (MapEdge & { fromTitle: string; toTitle: string })[]
  steps: (MapStep & { n: number })[]
}

export type NoteKind = 'likely' | 'check'

export type Note = {
  id: number
  kind: NoteKind
  text: string
  file: string | null
  line: number | null
  stop: number | null
  isCleared: boolean
}

export type Hunk = { source: string; path: string | null }

export type Walk = {
  pr: { number: number; title: string; url: string | null }
  summary: string | null
  stops: Stop[]
  current: number | null
  seen: number[]
  hunk: Hunk | null
  notes: Note[]
  isDone: boolean
  map: PrMap | null
  views: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'pr-assistant': { walk: Walk | null }
  }
}
