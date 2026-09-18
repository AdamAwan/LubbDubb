// → docs/spec/18-observability.md#telling-a-person-from-a-machine

/**
 * `bot` where the provider said so or the repository named the author as one; `person` otherwise.
 *
 * Two sources because they answer different halves. The provider knows its own apps — a GitHub App
 * posts as type `Bot` and cannot hide it — but it reports a service account on a personal access
 * token as an ordinary user, which is exactly the case the patterns exist for. Azure DevOps reports
 * nothing here at all, so on that provider the patterns are the whole of it.
 *
 * Unlisted and unclaimed reads as `person`. That is a **stated assumption, not a finding**: a new bot
 * nobody has named yet is counted as a person until somebody names it, which is why the reading draws
 * authors by name rather than only as a total — a machine among the people is visible to anyone
 * reading the rows, where a merged number would hide it.
 */
export function authorKind(
  author: string | null,
  providerSaidBot: boolean | null,
  patterns: readonly string[],
): 'bot' | 'person' {
  if (providerSaidBot === true) return 'bot';
  if (author === null) return 'person';
  for (const source of patterns) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source);
    } catch {
      continue;
    }
    if (pattern.test(author)) return 'bot';
  }
  return 'person';
}
