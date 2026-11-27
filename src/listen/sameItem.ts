import type { ListenItem, ListenerView } from '../types.js';

// → docs/spec/44-needs-you.md#the-wait

export function sameItem(a: ListenItem, b: ListenItem): boolean {
  return a.kind === 'ask' ? b.kind === 'ask' && a.id === b.id : b.kind === 'pr' && a.number === b.number;
}

/** Whether the listening chat holds this item: working it, or handed it and not yet done. */
export function inChat(listener: ListenerView, item: ListenItem): boolean {
  if (listener.on !== null && sameItem(listener.on, item)) return true;
  return listener.sent.some((entry) => sameItem(entry.item, item));
}

/** Whether anything of a goal's — an ask or a pull request — is in the listening chat. */
export function goalInChat(
  listener: ListenerView,
  goal: { asks: readonly { id: string }[]; prs: readonly { number: number }[] },
): boolean {
  return [
    ...goal.asks.map((a): ListenItem => ({ kind: 'ask', id: a.id })),
    ...goal.prs.map((pr): ListenItem => ({ kind: 'pr', number: pr.number })),
  ].some((item) => inChat(listener, item));
}
