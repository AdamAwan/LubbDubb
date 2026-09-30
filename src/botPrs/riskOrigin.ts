// → docs/spec/37-bot-prs.md#the-risk-summary

export function botPrRiskOrigin(runId: string): string {
  return `bot-prs:risk:${runId}`;
}

export function botPrRiskRunId(originRef: string | null): string | null {
  const match = /^bot-prs:risk:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}
