// → docs/spec/27-obstacles.md

export function corroborationGoal(originRef: string | null): string | null {
  const match = /^(issue|pr|job):([^:]+)(?::|$)/.exec(originRef ?? '');
  return match ? `${match[1]}:${match[2]}` : null;
}
