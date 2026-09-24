import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, seedProposedPlan, SENTINEL } from './support/revealGate.js';
import type { CockpitState } from '../src/wire.js';

async function payload(app: Awaited<ReturnType<typeof buildHarness>>['app']): Promise<CockpitState> {
  const res = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(res.statusCode, 200);
  return res.json() as CockpitState;
}

test('with both keys off the payload is exactly what it is today, and nothing is stamped', async () => {
  const { system, app, close } = await buildHarness(false);
  const { plan, escalation, proposal } = seedProposedPlan(system, 12, { caveats: true });

  for (const url of ['/api/goals/12/prediction', '/api/goals/12/reveal']) {
    const res = await app.inject({ method: 'POST', url, payload: { locus: 'a guess' } });
    assert.equal(res.statusCode, 404, `${url} is not mounted with the gate off`);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/goals/12/prediction' })).statusCode, 404);

  const state = await payload(app);
  const wire = state.plans.find((p) => p.id === plan.id)!;
  assert.equal(wire.document, plan.document, 'the plan body ships as it does today');
  assert.equal(wire.diagnosis, plan.diagnosis);
  assert.equal(wire.evidence.length, 1);
  assert.ok(state.planParts.some((p) => p.planId === plan.id));
  assert.ok(state.planAtoms.some((a) => a.planId === plan.id));
  assert.ok(state.escalations.find((e) => e.id === escalation.id)!.prompt.includes(SENTINEL));
  assert.ok(JSON.stringify(state.proposals.find((p) => p.id === proposal.id)!.action).includes(SENTINEL));
  assert.ok(
    state.plans.every((p) => p.revealed === true && p.revealedAt === null),
    'every plan reads revealed',
  );

  assert.equal(system.predictions.getReveal('issue:12'), null, 'reading a plan with the gate off stamps nothing');
  await close();
});

test('a withheld plan carries no prose anywhere in the payload', async () => {
  const { system, app, close } = await buildHarness(true);
  const { plan, escalation, proposal } = seedProposedPlan(system, 12, { caveats: true });

  const state = await payload(app);
  assert.equal(
    JSON.stringify(state).includes(SENTINEL),
    false,
    'the plan prose reaches the client by no path while it is withheld',
  );

  const wire = state.plans.find((p) => p.id === plan.id)!;
  assert.equal(wire.revealed, false);
  assert.equal(wire.revealedAt, null);
  assert.equal(wire.document, null);
  assert.equal(wire.reason, null);
  assert.deepEqual(wire.evidence, []);
  assert.equal(wire.title, `Goal 12`, 'id, title and status stay, or the cockpit cannot draw the gate');
  assert.equal(wire.status, 'awaiting_approval');
  assert.deepEqual(
    state.planParts.filter((p) => p.planId === plan.id),
    [],
  );
  assert.deepEqual(
    state.planAtoms.filter((a) => a.planId === plan.id),
    [],
  );
  assert.deepEqual(
    state.escalations.find((e) => e.id === escalation.id)!.context.detailFrom,
    'Withheld until the plan is revealed',
  );
  assert.deepEqual(
    (state.proposals.find((p) => p.id === proposal.id)!.action as unknown as { caveats: unknown[] }).caveats,
    [],
  );
  await close();
});

test('a plan that is not awaiting approval is not withheld, gate or no gate', async () => {
  const { system, app, close } = await buildHarness(true);
  const { plan } = seedProposedPlan(system, 12, { status: 'active' });

  const state = await payload(app);
  const wire = state.plans.find((p) => p.id === plan.id)!;
  assert.equal(wire.revealed, true, 'a plan approved while the gate was off has no stamp and never will');
  assert.equal(wire.document, plan.document);
  assert.ok(state.planParts.some((p) => p.planId === plan.id));
  await close();
});

test('the reveal is a server fact: it hands back the body, stamps once, and the payload follows', async () => {
  const { system, app, close } = await buildHarness(true);
  const { plan } = seedProposedPlan(system, 12);

  const res = await app.inject({ method: 'POST', url: '/api/goals/12/reveal' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { reveal: { revealedAt: string; predicted: boolean }; plan: { document: string } };
  assert.ok(body.plan.document.includes(SENTINEL), 'the reveal is what hands the document over');
  assert.equal(body.reveal.predicted, false);
  const stamped = system.predictions.getReveal('issue:12');
  assert.equal(stamped?.revealedAt, body.reveal.revealedAt);

  const state = await payload(app);
  const wire = state.plans.find((p) => p.id === plan.id)!;
  assert.equal(wire.revealed, true);
  assert.equal(wire.revealedAt, body.reveal.revealedAt);
  assert.equal(wire.document, plan.document);
  assert.ok(JSON.stringify(state).includes(SENTINEL), 'the body is back in the payload once it is revealed');
  assert.ok(state.planParts.some((p) => p.planId === plan.id));
  assert.ok(state.planAtoms.some((a) => a.planId === plan.id));

  const again = await app.inject({ method: 'POST', url: '/api/goals/12/reveal' });
  assert.equal(again.statusCode, 200);
  assert.equal(
    (again.json() as { reveal: { revealedAt: string } }).reveal.revealedAt,
    body.reveal.revealedAt,
    'a second press is idempotent and does not re-stamp',
  );
  await close();
});

test('a reveal cannot burn a gate it never opened', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 13, { status: 'active' });

  const noPlan = await app.inject({ method: 'POST', url: '/api/goals/99/reveal' });
  assert.equal(noPlan.statusCode, 409);
  assert.match((noPlan.json() as { error: string }).error, /no open goal/);
  assert.equal(system.predictions.getReveal('issue:99'), null, 'a goal never offered the gate is not a decline');

  const notProposed = await app.inject({ method: 'POST', url: '/api/goals/13/reveal' });
  assert.equal(notProposed.statusCode, 409);
  assert.equal(system.predictions.getReveal('issue:13'), null);
  await close();
});

test('the plan routes refuse while the plan is withheld, and answer once it is revealed', async () => {
  const { system, app, close } = await buildHarness(true);
  const { plan } = seedProposedPlan(system, 12);

  const before = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/history` });
  assert.equal(before.statusCode, 409);
  assert.match((before.json() as { error: string }).error, /has not been revealed/);

  const acceptance = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/acceptance`,
    payload: { slug: 'whole', criterion: `part acceptance ${SENTINEL}`, met: true },
  });
  assert.equal(acceptance.statusCode, 409);
  const profile = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/part-profile`,
    payload: { slug: 'whole' },
  });
  assert.equal(profile.statusCode, 409);
  const restart = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'whole' },
  });
  assert.equal(restart.statusCode, 409);

  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const after = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/history` });
  assert.equal(after.statusCode, 200);
  assert.ok(JSON.stringify(after.json()).includes(SENTINEL), 'history carries the raw document once revealed');

  const replan = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  assert.equal(replan.statusCode, 200);
  await close();
});

test('deciding a withheld plan is refused on every press, and goes through after a reveal', async () => {
  const { system, app, close } = await buildHarness(true);
  const withheld = /has not been revealed yet/;

  const arms = [
    { number: 21, url: (id: string) => `/api/proposals/${id}/accept`, body: {} as Record<string, unknown> },
    { number: 22, url: (id: string) => `/api/proposals/${id}/reject`, body: { note: 'no' } },
    { number: 23, url: (id: string) => `/api/proposals/${id}/back-out`, body: { verdict: 'hold' } },
  ];
  for (const arm of arms) {
    const { proposal } = seedProposedPlan(system, arm.number);
    const refused = await app.inject({ method: 'POST', url: arm.url(proposal.id), payload: arm.body });
    assert.equal(refused.statusCode, 409, `${arm.url('…')} refuses a plan nobody has seen`);
    assert.match((refused.json() as { error: string }).error, withheld);

    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/goals/${arm.number}/reveal` })).statusCode,
      200,
      'revealing is one press',
    );
    const allowed = await app.inject({ method: 'POST', url: arm.url(proposal.id), payload: arm.body });
    assert.equal(allowed.statusCode, 200, `${arm.url('…')} goes through once the plan has been revealed`);
  }

  const { escalation } = seedProposedPlan(system, 24);
  const dismissed = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/dismiss`,
    payload: {},
  });
  assert.equal(dismissed.statusCode, 409);
  assert.match((dismissed.json() as { error: string }).error, withheld);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/24/reveal' })).statusCode, 200);
  const cleared = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/dismiss`,
    payload: {},
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal((cleared.json() as { dismissedAs: string }).dismissedAs, 'proposal_rejected');
  await close();
});
