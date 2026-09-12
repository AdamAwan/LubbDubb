import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueOriginFamilies, issueOriginRef, issueOriginRole, parseIssueOrigin } from '../src/issueOrigins.js';

// Every string here is persisted — `tasks.origin_ref`, `decisions.rule`, plan part refs, escalation
// origins, `agentModels.byRule` prices — so each is spelled out rather than built.
const ROLES: Record<string, 'work' | 'evidence' | 'deliberation' | 'unrecognised'> = {
  'issue:12': 'work',
  'issue:12:part:schema': 'work',
  'issue:12:validate-local-fix:lv1': 'work',
  'issue:12:assess': 'evidence',
  'issue:12:retro': 'evidence',
  'issue:12:validate-plan': 'evidence',
  'issue:12:validate:merged-branch-gone': 'evidence',
  'issue:12:validate-failure:merged-branch-gone': 'evidence',
  'issue:12:validate-local:lv1': 'evidence',
  'issue:12:validate-remote:run1': 'evidence',
  'issue:12:plan': 'deliberation',
  'issue:12:appraisal': 'deliberation',
  'issue:12:sequence': 'deliberation',
  'issue:12:split:44': 'deliberation',
  'issue:12:summary': 'unrecognised',
  'issue:12:shortfall': 'unrecognised',
};

const MINTED: Record<string, string> = {
  root: issueOriginRef('root', 12),
  plan: issueOriginRef('plan', 12),
  appraisal: issueOriginRef('appraisal', 12),
  sequence: issueOriginRef('sequence', 12),
  summary: issueOriginRef('summary', 12),
  shortfall: issueOriginRef('shortfall', 12),
  assess: issueOriginRef('assess', 12),
  retro: issueOriginRef('retro', 12),
  validationPlan: issueOriginRef('validationPlan', 12),
  part: issueOriginRef('part', 12, 'schema'),
  split: issueOriginRef('split', 12, 44),
  validate: issueOriginRef('validate', 12, 'merged-branch-gone'),
  validateFailure: issueOriginRef('validateFailure', 12, 'merged-branch-gone'),
  localValidation: issueOriginRef('localValidation', 12, 'lv1'),
  localValidationFix: issueOriginRef('localValidationFix', 12, 'lv1'),
  remoteValidation: issueOriginRef('remoteValidation', 12, 'run1'),
};

test('each origin family mints exactly the string it has always minted', async () => {
  assert.deepEqual(MINTED, {
    root: 'issue:12',
    plan: 'issue:12:plan',
    appraisal: 'issue:12:appraisal',
    sequence: 'issue:12:sequence',
    summary: 'issue:12:summary',
    shortfall: 'issue:12:shortfall',
    assess: 'issue:12:assess',
    retro: 'issue:12:retro',
    validationPlan: 'issue:12:validate-plan',
    part: 'issue:12:part:schema',
    split: 'issue:12:split:44',
    validate: 'issue:12:validate:merged-branch-gone',
    validateFailure: 'issue:12:validate-failure:merged-branch-gone',
    localValidation: 'issue:12:validate-local:lv1',
    localValidationFix: 'issue:12:validate-local-fix:lv1',
    remoteValidation: 'issue:12:validate-remote:run1',
  });
});

test('every declared family is minted, parsed and classified, so a new one cannot arrive unclassified', async () => {
  assert.deepEqual([...issueOriginFamilies].sort(), Object.keys(MINTED).sort());

  for (const family of issueOriginFamilies) {
    const ref = MINTED[family];
    assert.ok(ref !== undefined, `family ${family} mints nothing this test asserts`);
    const parsed = parseIssueOrigin(ref);
    assert.deepEqual(
      { family: parsed?.family, issueNumber: parsed?.issueNumber },
      { family, issueNumber: 12 },
      `${ref} parses back to ${family}`,
    );
    assert.equal(issueOriginRole(12, ref), ROLES[ref], `${ref} carries its declared role`);
  }
});

test('an origin outside the issue, or under an unknown suffix, keeps its own answer', async () => {
  assert.equal(issueOriginRole(12, null), null);
  assert.equal(issueOriginRole(12, 'issue:120'), null);
  assert.equal(issueOriginRole(12, 'pr:40:ci'), null);
  assert.equal(issueOriginRole(12, 'issue:12:something-added-later'), 'unrecognised');
  assert.equal(parseIssueOrigin('issue:12:something-added-later'), null);
  assert.equal(parseIssueOrigin('pr:40:ci'), null);
  assert.equal(parseIssueOrigin(null), null);
});

test('a role is judged on the suffix, so a malformed id is still that family', async () => {
  assert.equal(issueOriginRole(12, 'issue:12:validate-local:'), 'evidence');
  assert.equal(issueOriginRole(12, 'issue:12:validate-local-fix:no such id'), 'work');
  assert.equal(issueOriginRole(12, 'issue:12:part:'), 'work');
  assert.equal(issueOriginRole(12, 'issue:12:validate-plan:extra'), 'unrecognised');
});
