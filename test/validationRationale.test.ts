import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { ValidationCheckSchema, validationCheckSetInputs } from '../src/validation/checkDocument.js';
import { NO_STEP_CAPABILITIES } from '../src/validation/steps.js';
import { proposedCheckSet } from '../src/validation/planApproval.js';

// → docs/spec/20-validation.md#rationale

const DECLARED = {
  id: 'retry-on-5xx',
  title: 'A 5xx from intake is retried',
  do: 'Trigger a 5xx on intake',
  expect: 'The fetch is retried three times',
  rationale: 'The retry is the whole change.',
};

test('a check carries its rationale from the document to the store and onto the accept card', () => {
  const parsed = ValidationCheckSchema.parse(DECLARED);
  const [input] = validationCheckSetInputs([parsed], [], [], NO_STEP_CAPABILITIES);
  assert.equal(input?.rationale, 'The retry is the whole change.');

  const store = new Store(':memory:');
  try {
    store.validation.ingestValidation('issue:12', {
      checks: [input!],
      resources: [],
      supersededReason: '',
      amendNote: '',
    });
    const [check] = store.validation.listValidationChecks('issue:12');
    assert.equal(check?.rationale, 'The retry is the whole change.');
    assert.equal(proposedCheckSet([check!])[0]?.rationale, 'The retry is the whole change.');

    store.validation.ingestValidation('issue:12', {
      checks: [{ ...input!, rationale: null }],
      resources: [],
      supersededReason: '',
      amendNote: '',
    });
    assert.equal(
      store.validation.listValidationChecks('issue:12')[0]?.rationale,
      'The retry is the whole change.',
      'a re-declaration that says nothing keeps the line it had',
    );
  } finally {
    store.close();
  }
});

test('a rationale is optional, and an empty one is refused rather than stored', () => {
  const { rationale: _omitted, ...without } = DECLARED;
  assert.equal(ValidationCheckSchema.safeParse(without).success, true, 'a check written before the field carries none');
  assert.equal(ValidationCheckSchema.safeParse({ ...DECLARED, rationale: '  ' }).success, false);
});
