import type { IssueSpend, PlanPartView, PlanningPolicy, QueueItem } from '../types.js';

export function Decision({
  parts,
  planning,
  spend,
  queued,
  originOf,
  issueNumber,
}: {
  parts: PlanPartView[];
  planning: PlanningPolicy;
  spend: IssueSpend | null;
  queued: Map<string, QueueItem>;
  originOf: (slug: string) => string;
  issueNumber: number | null;
}) {
  const human = parts.filter((p) => p.expectedKind === 'human');
  const agentParts = parts.filter((p) => p.expectedKind !== 'human');
  const prs = agentParts.filter((p) => p.expectedKind === null || p.expectedKind === 'code');
  const startsNow = agentParts.filter((p) => queued.get(originOf(p.slug)) !== undefined && p.dependsOn.length === 0);
  const large = parts.filter((p) => p.size === 'l');
  const stats: { n: string; label: string; warn?: boolean }[] = [
    { n: String(parts.length === 0 ? 1 : prs.length), label: parts.length === 0 ? 'pull request' : 'pull requests' },
    { n: String(parts.length === 0 ? 1 : agentParts.length), label: 'agents, over time' },
    { n: String(Math.max(1, planning.maxConcurrentPartsPerIssue)), label: 'at once, max' },
    { n: String(parts.length === 0 ? 1 : Math.max(startsNow.length, 1)), label: 'starts immediately' },
  ];
  if (human.length > 0)
    stats.push({ n: String(human.length), label: human.length === 1 ? 'step for you' : 'steps for you' });
  if (large.length > 0) stats.push({ n: String(large.length), label: 'large to review', warn: true });
  if (spend !== null) stats.push({ n: `$${spend.costUsd.toFixed(2)}`, label: 'spent getting here', warn: true });

  return (
    <div className="pm-authorising">
      {stats.map((s) => (
        <div className={`pm-stat${s.warn === true ? ' warn' : ''}`} key={s.label}>
          <b>{s.n}</b>
          <span>{s.label}</span>
        </div>
      ))}
      <span className="spacer" />
      {issueNumber !== null && parts.length > 0 && (
        <span className="pm-branches">
          on <code>issue/{issueNumber}/…</code>
        </span>
      )}
    </div>
  );
}

export function approveLabel(
  parts: PlanPartView[],
  queued: Map<string, QueueItem>,
  originOf: (slug: string) => string,
): string {
  if (parts.length === 0) return 'Approve — work it as one PR';
  const now = parts.filter(
    (p) => p.expectedKind !== 'human' && p.dependsOn.length === 0 && queued.has(originOf(p.slug)),
  );
  const count = Math.max(now.length, 1);
  return `Approve — start ${count} agent${count === 1 ? '' : 's'} now`;
}
