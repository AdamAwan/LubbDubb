export type Notice = { id: string; kind: 'question' | 'approval' | 'task'; title: string }

export type Board = { notices: Notice[]; paused: boolean }

declare module 'claude-code' {
  interface PluginState {
    'lubbdubb-board': { board: Board | null; isHidden: boolean }
  }
}
