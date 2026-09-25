import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';
import { buildApp } from '../../src/server/app.js';
import { buildSystem, type System } from '../../src/system/system.js';
import { FakePtyBackend } from '../../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../../src/worktree/fakeWorktreeManager.js';
import { ingestPlanDocument } from '../../src/plans/planIngest.js';
import { parsePlanDocument } from '../../src/plans/planDocument.js';
import { planProposalRef } from '../../src/proposals/proposals.js';
import type { Action } from '../../src/types.js';
import type { Escalation, Plan, PlanStatus, Proposal } from '../../src/types.js';

/** The one string every narrative field of a seeded plan carries. */
export const SENTINEL = 'xyzzy-plum-sentinel';

interface Harness {
  system: System;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  close: () => Promise<void>;
}

export async function buildHarness(gate: boolean): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reveal-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    prediction: { enabled: gate },
    goalCriteria: { enabled: false },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return {
    system,
    app,
    close: async () => {
      await app.close();
      system.store.close();
    },
  };
}

interface SeededPlan {
  plan: Plan;
  escalation: Escalation;
  proposal: Proposal;
}

/**
 * A goal with a plan whose every narrative field, part and atom carries `SENTINEL`,
 * put to the operator exactly as `propose_plan` puts one: an `approve_change`
 * escalation and the `plan` proposal behind it.
 */
export function seedProposedPlan(
  system: System,
  number: number,
  opts: { status?: PlanStatus; caveats?: boolean } = {},
): SeededPlan {
  system.connector.inject({ kind: 'new_issue', number, title: `Goal ${number}`, body: 'Several PRs.' });
  const originRef = `issue:${number}`;
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: `reason ${SENTINEL}`,
      diagnosis: `diagnosis ${SENTINEL}`,
      approach: `approach ${SENTINEL}`,
      risks: `risks ${SENTINEL}`,
      outOfScope: `out of scope ${SENTINEL}`,
      alternatives: `alternatives ${SENTINEL}`,
      openQuestions: `open questions ${SENTINEL}`,
      verification: `verification ${SENTINEL}`,
      document: `# The plan\n\n${SENTINEL}`,
      evidence: [{ path: 'src/thing.ts', line: 4, note: `evidence ${SENTINEL}` }],
      atoms: [{ slug: 'atom-one', title: `atom ${SENTINEL}`, intent: `atom intent ${SENTINEL}` }],
      parts: [
        {
          slug: 'whole',
          title: `part ${SENTINEL}`,
          scope: `part scope ${SENTINEL}`,
          atoms: ['atom-one'],
          rationale: `part rationale ${SENTINEL}`,
          acceptance: `part acceptance ${SENTINEL}`,
          dependsOn: [],
        },
      ],
    }),
  );
  assert.ok(doc.ok, doc.ok ? '' : doc.error);
  const { plan } = ingestPlanDocument(system.store, { doc: doc.document, originRef, title: `Goal ${number}` });
  if (opts.status && opts.status !== 'awaiting_approval') system.store.plans.setPlanStatus(plan.id, opts.status);

  const caveats = opts.caveats
    ? [{ id: 'cav-1', label: `caveat ${SENTINEL}`, detail: `caveat detail ${SENTINEL}` }]
    : [];
  const escalation = system.escalations.create({
    type: 'approve_change',
    prompt: `Approve the plan for #${number}?\n\n${SENTINEL}`,
    context: {
      originRef,
      planId: plan.id,
      detail: `What the plan says: ${SENTINEL}`,
      detailFrom: 'What the plan says',
    },
  });
  const action = {
    type: 'propose_plan',
    planId: plan.id,
    originRef,
    detail: `What the plan says: ${SENTINEL}`,
    caveats,
    prompt: `Approve the plan for #${number}?\n\n${SENTINEL}`,
    rule: 'plan-approval',
    reason: `Issue #${number} has a 1-part plan.`,
  } as unknown as Action;
  const proposal = system.store.escalations.createProposal({
    kind: 'plan',
    ref: planProposalRef(originRef),
    action,
    escalationId: escalation.id,
  });
  return { plan: system.store.plans.getPlan(plan.id)!, escalation, proposal };
}
