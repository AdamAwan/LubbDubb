// → docs/spec/05-dispatcher.md (the rule book)

export function readOnlyDispatch(name: string, of: string): { branch: string; base: string; readOnly: true } {
  return { branch: name, base: of, readOnly: true };
}

export function readOnlyNote(submitting: string): string {
  return (
    '\n\n## Your checkout is detached, and nothing is committed from it\n\n' +
    'You are not on a branch. A commit made here is on no ref, reaches nobody, and is wiped when the slot ' +
    `is handed on — so do not commit, push, or open a pull request. ${submitting}`
  );
}
