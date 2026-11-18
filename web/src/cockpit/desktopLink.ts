// → docs/spec/17-cockpit.md#the-address-bar

/** Every skill the plugin carries — one directory each under `plugin/skills/`, which a test holds this to. */
export const SKILL_NAMES = [
  'ask',
  'check',
  'clarify',
  'describe',
  'discuss',
  'eject',
  'extension',
  'feature',
  'file',
  'fleet',
  'listen',
  'next',
  'order',
  'plan',
  'pr',
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

/** → docs/spec/40-discussions.md#talking-it-through-in-claude */
export function discussionPrompt(issueNumber: number): string {
  return skillPrompt('discuss', `${issueNumber} `);
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

/** → docs/spec/44-needs-you.md#is-a-chat-listening */
export function listenPrompt(): string {
  return skillPrompt('listen').trimEnd();
}

/** → docs/spec/44-needs-you.md#the-claude-button */
export function prPrompt(prNumber: number): string {
  return skillPrompt('pr', String(prNumber));
}

export function askOnlyPrompt(askId: string): string {
  return skillPrompt('next', `${askId} only`);
}
