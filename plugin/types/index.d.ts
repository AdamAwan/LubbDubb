export type Notice = { id: string; kind: string; title: string; urgent: boolean }

export type Feature = { number: number; title: string; delivered: number; inFlight: number; blocked: number; total: number }

export type PrTone = 'good' | 'warn' | 'bad' | 'quiet'

export type Pr = { number: number; title: string; state: string; tone: PrTone; url: string | null }

export type Agent = { id: string; title: string; isWaiting: boolean; costUsd: number; startedAt: string }

export type Queued = { origin: string; title: string; status: string }

export type Board = {
  notices: Notice[]
  features: Feature[]
  prs: Pr[]
  agents: Agent[]
  upNext: Queued[]
  paused: boolean
  cap: number
}

declare module 'claude-code' {
  interface PluginState {
    lubbdubb: { board: Board | null; isHidden: boolean }
  }
}
