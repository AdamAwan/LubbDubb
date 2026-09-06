// → docs/spec/28-cross-fleet-pool.md

interface SecretPattern {
  label: string;
  pattern: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { label: 'a PEM private key header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'an OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'credentials embedded in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
];

export function secretRefusal(text: string): string | null {
  const found = PATTERNS.find((entry) => entry.pattern.test(text));
  return found ? `it looks like it contains ${found.label}` : null;
}
