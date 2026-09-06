// → docs/spec/18-observability.md

export function debugEnabled(): boolean {
  return !!process.env.LUBBDUBB_DEBUG;
}

export function debugLog(scope: string, message: string): void {
  if (debugEnabled()) console.error(`[lubbdubb:debug:${scope}] ${JSON.stringify(message)}`);
}
