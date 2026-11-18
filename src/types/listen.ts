// → docs/spec/44-needs-you.md

/** What the Needs you page hands a listening Claude chat: one ask, or one pull request. */
export type ListenItem = { kind: 'ask'; id: string } | { kind: 'pr'; number: number };

export type ListenerState = 'listening' | 'busy' | 'off';

export interface ListenerView {
  state: ListenerState;
  /** The item the chat is working inline while `busy`; null otherwise. */
  on: ListenItem | null;
  /** Items sent and not yet handed to the chat. */
  queued: number;
  /** Items handed to the chat that still stand, newest first, each with when it was sent. */
  sent: { item: ListenItem; sentAt: string }[];
}
