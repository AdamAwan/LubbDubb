// → docs/spec/17-cockpit.md#the-address-bar

export function desktopDeepLink(folder: string, prompt: string): string {
  const query = new URLSearchParams({ q: prompt, folder });
  return `claude://code/new?${query.toString()}`;
}

export function discussPrompt(issueNumber: number): string {
  return `/lubbdubb discuss ${issueNumber}`;
}

export function localRunPrompt(issueNumber: number): string {
  return `/lubbdubb run ${issueNumber}`;
}

export function askPrompt(issueNumber: number): string {
  return `/lubbdubb ask ${issueNumber} `;
}

export function checkPrompt(issueNumber: number, letter: string): string {
  return `/lubbdubb ${issueNumber}:${letter}`;
}

export function questionPrompt(): string {
  return '/lubbdubb ';
}
