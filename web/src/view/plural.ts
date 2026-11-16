/** A count and its noun: `1 check`, `3 checks`; `many` where adding an `s` is wrong. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
