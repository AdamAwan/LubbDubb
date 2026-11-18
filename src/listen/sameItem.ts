import type { ListenItem } from '../types.js';

// → docs/spec/44-needs-you.md#the-wait

export function sameItem(a: ListenItem, b: ListenItem): boolean {
  return a.kind === 'ask' ? b.kind === 'ask' && a.id === b.id : b.kind === 'pr' && a.number === b.number;
}
