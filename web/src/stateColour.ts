// → docs/spec/17-cockpit.md#tokens

const HEX = /^#[0-9a-f]{6}$/i;

export function isStateColour(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

export function stateColourKey(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function stateColour(colours: Readonly<Record<string, string>>, state: string): string | null {
  const want = stateColourKey(state);
  for (const [key, value] of Object.entries(colours)) {
    if (stateColourKey(key) === want && isStateColour(value)) return value;
  }
  return null;
}
