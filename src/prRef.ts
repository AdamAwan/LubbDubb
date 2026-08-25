/**
 * How a pull request is named **in prose**, which is not the same question on
 * every provider.
 *
 * GitHub reads `#12` as "issue or pull request 12" — one id space, and the link
 * resolves either way. Azure DevOps does not: work items and pull requests are
 * disjoint id spaces there (the same fact `azureRefUrl` refuses to guess on), and
 * its markdown says so with two sigils — `#12` is **work item** 12 and `!12` is
 * **pull request** 12. So a body that names a pull request as `#12` on Azure does
 * not fail to link: it links, confidently, to an unrelated work item.
 *
 * That is the whole reason this exists as a value rather than a literal. Nothing
 * about a wrong reference is red — the description renders, the link works, and
 * only a reader who follows it finds a ticket about something else.
 *
 * The **issue** reference is deliberately not routed through here: `#12` is what
 * both providers mean by a tracker item, so `open_pr`'s appended `Relates to #12`
 * is already right on Azure. → `docs/spec/07-pull-requests.md#naming-a-pull-request`
 */
export type PrRefStyle = '#' | '!';

/** The sigil this source-control provider's markdown reads as "pull request". */
export function prRefStyle(sourceControl: string): PrRefStyle {
  return sourceControl === 'azure' ? '!' : '#';
}

/** One pull request, written the way the configured provider links it. */
export function prRef(number: number, style: PrRefStyle): string {
  return `${style}${number}`;
}
