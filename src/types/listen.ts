// → docs/spec/44-needs-you.md

/** Why the harness sent a pull request by itself: a review asked of the operator, or one of theirs ready. */
export type AutoSendWhy = 'review' | 'ready';

/** What the Needs you page hands a listening Claude chat: one ask, or one pull request. */
export type ListenItem = { kind: 'ask'; id: string } | { kind: 'pr'; number: number; why?: AutoSendWhy };

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
