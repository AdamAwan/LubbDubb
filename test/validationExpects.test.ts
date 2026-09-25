import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store/store.js';
import { preflightRows } from '../src/validation/remote/preflight.js';
import { stepExpects } from '../src/validation/steps.js';
import type { SelectorListing } from '../src/validation/remote/runner.js';
import type { RemoteSheetRow, ValidationCheck, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * The concrete spec names a check's `suite` step wrote down against its area, and the one thing the
 * counts cannot reach. An area runs whatever it currently holds,
 * so a spec deleted or renamed since the check was written lowers what ran and the listing's own
 * denominator together — `executed < matched` never fires, and only a name somebody wrote down can
 * be missed.
 *
 * Null is *the planner named no expectation* and must never fold into *expected nothing*: the first
 * is every check whose author named none, and the two readings are a pass and a block apart.
 *
 * Both the area and the expectation are read off the step and off nothing else; the columns that
 * once held them are retired (`test/validationColumnRetirement.test.ts`).
 *
 * → docs/spec/36-remote-validation.md#an-expected-spec-the-runner-does-not-offer
 */

const ENVIRONMENT = 'acceptance';
const AREA = 'checkout';
const GOAL = 'issue:12';

/** The area, and two of the specs it holds, exactly as a runner lists them. */
const LISTING: SelectorListing = {
  offers: [
    { selector: AREA, tests: 7 },
    { selector: 'checkout/places-an-order.spec.ts', tests: 1 },
    { selector: 'checkout/refunds-an-order.spec.ts', tests: 1 },
  ],
  detail: null,
};

function rows(): Pick<RemoteSheetRow, 'rowId' | 'kind' | 'sourceId' | 'blockedReason'>[] {
  return [{ rowId: 'check:an-order-places', kind: 'check', sourceId: 'an-order-places', blockedReason: null }];
}

/** A check with the test plan an area and an expectation actually live on: one `suite` step. */
function check(expects: string[] | null, area: string | null = AREA): ValidationCheck {
  return { id: 'an-order-places', steps: area === null ? [] : [suiteStep(area, expects)] } as ValidationCheck;
}

function suiteStep(area: string, expects: string[] | null): ValidationStep {
  return {
    kind: 'suite',
    do: `Run the ${area} area`,
    area,
    expects,
    when: 'inline',
    script: null,
    scriptSweptAt: null,
    actor: 'fleet',
    why: null,
  };
}

function verdicts(check: ValidationCheck, listing: SelectorListing = LISTING): ReturnType<typeof preflightRows> {
  return preflightRows({ environment: ENVIRONMENT, rows: rows(), checks: [check], listing });
}

// ------------------------------------------------------- a check that named no expectation

test('a check that named no expectation is read exactly as it was before the column existed', () => {
  assert.deepEqual(
    verdicts(check(null)),
    [{ rowId: 'check:an-order-places', matched: 7, blockedReason: null }],
    'null is "no expectation was named" and never "expected nothing" — folding the two together ' +
      'would block every check written before the column, with a full sheet and nothing red',
  );
});

test('the matched count of a check that named no expectation still comes from the area’s own offer', () => {
  const [verdict] = verdicts(check(null));
  assert.equal(
    verdict?.matched,
    7,
    'the count is written from the listing and from nowhere else: the expectation column adds a ' +
      'reading beside it and never becomes the denominator',
  );
});

test('a null expectation changes none of the causes that already blocked a row', () => {
  const unoffered = verdicts(check(null), { offers: [{ selector: 'refunds', tests: 3 }], detail: null })[0];
  assert.equal(unoffered?.matched, 0);
  assert.match(
    unoffered?.blockedReason ?? '',
    /offers no selector `checkout`/,
    'an area the runner does not offer reads exactly as it did before the column',
  );

  const empty = verdicts(check(null), { offers: [{ selector: AREA, tests: 0 }], detail: null })[0];
  assert.equal(empty?.matched, 0);
  assert.match(empty?.blockedReason ?? '', /holds no tests/, 'and an area that holds nothing is still never a pass');

  const unlistable = verdicts(check(null), { offers: null, detail: 'the command exited 127' })[0];
  assert.equal(
    unlistable?.matched,
    null,
    'and a listing that could not answer counts nothing, rather than reading as a runner that offers nothing',
  );
  assert.match(unlistable?.blockedReason ?? '', /could not say which selectors it offers/);
});

// ------------------------------------------------ an expectation the runner no longer offers

test('a spec the check expected and the runner does not offer blocks the row, and the reason names it', () => {
  const [verdict] = verdicts(check(['checkout/places-an-order.spec.ts', 'checkout/gift-cards.spec.ts']));
  assert.notEqual(
    verdict?.blockedReason,
    null,
    'a deleted spec lowers what ran and what the listing counts together, so this is the only ' +
      'place the loss can be seen at all',
  );
  assert.match(
    verdict?.blockedReason ?? '',
    /`checkout\/gift-cards\.spec\.ts`/,
    'the reason names the spec that went missing — an operator cannot act on "something is missing"',
  );
  assert.match(
    verdict?.blockedReason ?? '',
    /offers no spec `checkout\/gift-cards\.spec\.ts`/,
    'only the missing name is reported missing — the one the runner still honours is not part of the shortfall',
  );
  assert.match(
    verdict?.blockedReason ?? '',
    /It offers .*`checkout\/places-an-order\.spec\.ts`/,
    'and what it does offer is printed beside it, because a rename is read by comparing the two',
  );
});

test('a check whose expectation is missing is blocked rather than passing on the specs that remain', () => {
  const [verdict] = verdicts(check(['checkout/gift-cards.spec.ts']));
  assert.notEqual(
    verdict?.blockedReason,
    null,
    'a pass on what remains is a pass for coverage that is gone, which is the failure this column exists to catch',
  );
  assert.match(
    verdict?.blockedReason ?? '',
    /Nothing here was run/,
    'and the row says nothing ran, rather than reporting a reading on the remainder',
  );
  assert.equal(
    verdict?.matched,
    7,
    'the area’s own count is still recorded, so the blocked row shows what the runner does hold',
  );
});

test('every missing expectation is named, not just the first', () => {
  const [verdict] = verdicts(check(['checkout/gift-cards.spec.ts', 'checkout/loyalty.spec.ts']));
  assert.match(verdict?.blockedReason ?? '', /`checkout\/gift-cards\.spec\.ts`/);
  assert.match(
    verdict?.blockedReason ?? '',
    /`checkout\/loyalty\.spec\.ts`/,
    'an operator fixing one at a time re-presses for each, so the whole shortfall is stated once',
  );
});

// ------------------------------------------------------- an expectation the runner honours

test('an expectation the listing fully offers does not block, and matched is still the area’s own count', () => {
  const [verdict] = verdicts(check(['checkout/places-an-order.spec.ts', 'checkout/refunds-an-order.spec.ts']));
  assert.equal(verdict?.blockedReason, null, 'every name the check wrote down is on offer, so there is nothing to say');
  assert.equal(
    verdict?.matched,
    7,
    'matched is what the runner attributes to the area, never the size of the expectation — the two ' +
      'named specs are a subset of the seven the area holds, and reading the expectation as the ' +
      'denominator would let a shrinking area pass',
  );
});

test('a check that names no area is not a question for the runner, whatever it expected', () => {
  assert.deepEqual(
    verdicts(check(['checkout/places-an-order.spec.ts'], null)),
    [],
    'a check declaring no area is a person’s, and the pre-flight asks a runner about areas',
  );
});

// --------------------------------------------------------------------- the store

function input(over: Partial<ValidationCheckInput>): ValidationCheckInput {
  return {
    id: 'an-order-places',
    seq: 1,
    title: 'An order still places',
    do: 'Place one.',
    expect: 'It places.',
    proof: null,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    steps: [suiteStep(AREA, null)],
    ...over,
  };
}

test('an expectation written on a check is the list that is read back, and an empty one reads as none', () => {
  const store = new Store(':memory:');
  try {
    store.validation.ingestValidation(GOAL, {
      checks: [
        input({ steps: [suiteStep(AREA, ['checkout/places-an-order.spec.ts'])] }),
        input({ id: 'refunds-work', seq: 2, title: 'Refunds still work', steps: [suiteStep(AREA, [])] }),
        input({ id: 'prose-only', seq: 3, title: 'Somebody looks', steps: [] }),
      ],
      resources: [],
      supersededReason: 'no longer declared',
      amendNote: 'first write',
    });
    const back = store.validation.listValidationChecks(GOAL);
    const expectsOf = (id: string): string[] | null => stepExpects(back.find((c) => c.id === id)?.steps ?? []);
    assert.deepEqual(
      expectsOf('an-order-places'),
      ['checkout/places-an-order.spec.ts'],
      'the names the run\u2019s listing compares character for character survive the round trip unchanged',
    );
    assert.equal(
      expectsOf('refunds-work'),
      null,
      'an empty list normalises to null on the way back out too: an expectation of nothing is not one',
    );
    assert.equal(
      expectsOf('prose-only'),
      null,
      'and a check that declares no plan at all names no expectation, which is the same fact',
    );
  } finally {
    store.close();
  }
});

// --------------------------------------------------- the columns that were retired

test('no backfill and no runOnce id came with any of it', () => {
  const source = readFileSync('src/store/store.ts', 'utf8');
  assert.ok(!/expects/.test(source), 'nothing in the boot sequence is gated on either column');
  assert.ok(!/runOnce/.test(source), 'and no one-shot id came back with it');
});
