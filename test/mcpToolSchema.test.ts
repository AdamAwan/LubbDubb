import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { enumOf, toolSchema } from '../src/mcp/schema.js';
import { ReportSchema, validateReport } from '../src/validation/report.js';

// → docs/spec/11-mcp-tools.md

function prop(json: Record<string, unknown>, name: string): Record<string, unknown> {
  const props = json.properties as Record<string, Record<string, unknown>> | undefined;
  const found = props?.[name];
  assert.ok(found, `schema declares no "${name}"`);
  return found;
}

test('toolSchema renders a plain JSON Schema object with no $schema key', () => {
  const json = toolSchema(z.object({ note: z.string().describe('what you saw') }));
  assert.equal(json.$schema, undefined);
  assert.deepEqual(json.type, 'object');
  assert.deepEqual(json.properties, { note: { type: 'string', description: 'what you saw' } });
  assert.deepEqual(json.required, ['note']);
});

test('an optional field is absent from required', () => {
  const json = toolSchema(z.object({ a: z.string(), b: z.string().optional() }));
  assert.deepEqual(json.required, ['a']);
});

test('additionalProperties is emitted only where the validator rejects unknown keys', () => {
  assert.equal(toolSchema(z.object({ a: z.string() })).additionalProperties, undefined);
  assert.equal(toolSchema(z.object({ a: z.string() }).strict()).additionalProperties, false);
});

test('strictness is still read through a refinement', () => {
  const refined = z
    .object({ a: z.string() })
    .strict()
    .superRefine(() => {});
  assert.equal(toolSchema(refined).additionalProperties, false);
});

test('enumOf accepts a list built at runtime', () => {
  const names: readonly string[] = ['alpha', 'beta'];
  const json = toolSchema(z.object({ pick: enumOf(names) }));
  assert.deepEqual(prop(json, 'pick').enum, ['alpha', 'beta']);
});

// The regression this whole derivation exists to close: validation_report advertised a schema
// that permitted what its own validator refused, and neither file was wrong on its own.
test('validation_report advertises exactly what validateReport enforces', () => {
  const json = toolSchema(ReportSchema);

  assert.equal(json.additionalProperties, false);
  assert.equal(
    validateReport({ result: 'passed', note: 'saw it', extra: 'x' }).ok,
    false,
    'the validator rejects unknown keys, so the schema must say so',
  );

  assert.equal(prop(json, 'note').minLength, 1);
  assert.equal(validateReport({ result: 'passed', note: '' }).ok, false, 'an empty note is refused');

  assert.deepEqual(prop(json, 'result').enum, ['passed', 'failed', 'handback']);
  assert.equal(validateReport({ result: 'maybe', note: 'saw it' }).ok, false);
  assert.equal(validateReport({ result: 'passed', note: 'saw it' }).ok, true);
});
