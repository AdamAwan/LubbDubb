// → docs/spec/44-needs-you.md#the-claude-button

export const LISTEN_PROMPT = '/lubbdubb:listen';

export function prPrompt(prNumber: number): string {
  return `/lubbdubb:pr ${prNumber}`;
}

export function askOnlyPrompt(askId: string): string {
  return `/lubbdubb:next ${askId} only`;
}
