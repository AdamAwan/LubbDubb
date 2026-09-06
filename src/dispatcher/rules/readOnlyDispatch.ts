// → docs/spec/05-dispatcher.md (the rule book)

export function readOnlyDispatch(name: string, of: string): { branch: string; base: string; readOnly: true } {
  return { branch: name, base: of, readOnly: true };
}
