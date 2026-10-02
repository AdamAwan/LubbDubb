// → docs/spec/17-cockpit.md#the-address-bar

/** Every skill the plugin carries — one directory each under `plugin/skills/`, which a test holds this to. */
export const SKILL_NAMES = [
  'ask',
  'check',
  'clarify',
  'describe',
  'eject',
  'feature',
  'file',
  'fleet',
  'order',
  'plan',
  'run',
] as const;

type SkillName = (typeof SKILL_NAMES)[number];

function skillPrompt(skill: SkillName, argument = ''): string {
  return `/lubbdubb:${skill} ${argument}`;
}

export function desktopDeepLink(folder: string, prompt: string): string {
  const query = new URLSearchParams({ q: prompt, folder });
  return `claude://code/new?${query.toString()}`;
}

export function discussPrompt(issueNumber: number): string {
  return skillPrompt('plan', String(issueNumber));
}

export function ejectPrompt(issueNumber: number): string {
  return skillPrompt('eject', String(issueNumber));
}

export function localRunPrompt(issueNumber: number): string {
  return skillPrompt('run', String(issueNumber));
}

export function askPrompt(issueNumber: number): string {
  return skillPrompt('ask', `${issueNumber} `);
}

export function featurePrompt(issueNumber: number): string {
  return skillPrompt('feature', `${issueNumber} `);
}

export function checkPrompt(issueNumber: number, letter: string): string {
  return skillPrompt('check', `${issueNumber}:${letter}`);
}

export function descriptionPrompt(issueNumber: number, slug: string): string {
  return skillPrompt('describe', `${issueNumber}:${slug}`);
}

export function questionPrompt(): string {
  return skillPrompt('fleet');
}
