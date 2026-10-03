export type StopKind = 'changed' | 'new' | 'removed' | 'unchanged'

export type Stop = { title: string; kind: StopKind; files: string[] }

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
}

declare module 'claude-code' {
  interface PluginState {
    'pr-assistant': { walk: Walk | null }
  }
}
