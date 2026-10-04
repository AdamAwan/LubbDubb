import { z } from 'zod';

// → docs/spec/16-http-api.md#request-validation

export function strictObject<S extends z.ZodRawShape>(shape: S, unknownKeys: string) {
  return z.strictObject(shape, { error: (issue) => (issue.code === 'unrecognized_keys' ? unknownKeys : undefined) });
}

export function absentOr(
  absent: string,
  wrongType?: string,
): { error: (issue: { input?: unknown }) => string | undefined } {
  return { error: (issue) => (issue.input === undefined ? absent : wrongType) };
}
