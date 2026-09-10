import type { ValidationStep, ValidationStepKind } from '../types.js';

// → docs/spec/20-validation.md#the-test-plan

export const STEP_KINDS: readonly ValidationStepKind[] = [
  'browser',
  'suite',
  'screenshot',
  'state',
  'signal',
  'measure',
  'manual',
];

/**
 * What the deployment declares it can drive, folded once across every configured environment. This
 * is the whole of what decides who carries a step: a step whose kind nothing here permits is a step
 * the fleet cannot carry, which is a fact about the configuration rather than a nomination.
 * → docs/spec/20-validation.md#who-carries-a-step
 */
export interface StepCapabilities {
  /** Some environment declares a `validate.browser` block. */
  browser: boolean;
  /** Some environment declares `validate.state.run`. */
  state: boolean;
  /** Some environment declares a `watch.observe` command. */
  observe: boolean;
  /** Some environment names a tenant — a literal, a variable, or an `ensureTenant` command. */
  tenant: boolean;
}

/**
 * No environment declares anything, which is every deployment that has not configured one — and the
 * reading a check set authored through a transport that was handed no configuration gets. Every step
 * is a person's, which is the direction this must fail in: a check whose steps are a person's is on
 * the sheet and waiting, where one wrongly assigned to a fleet that cannot carry it is dispatched,
 * held, and blocking nothing.
 */
export const NO_STEP_CAPABILITIES: StepCapabilities = { browser: false, state: false, observe: false, tenant: false };

interface CapabilityEnvironment {
  watch?: { observe?: string };
  validate?: {
    tenant?: string;
    tenantEnv?: string;
    ensureTenant?: string;
    browser?: unknown;
    state?: { run?: string };
  };
}

export function stepCapabilities(environments: readonly CapabilityEnvironment[]): StepCapabilities {
  const caps = { ...NO_STEP_CAPABILITIES };
  for (const env of environments) {
    const validate = env.validate;
    if (validate === undefined) continue;
    if (validate.browser !== undefined) caps.browser = true;
    if (typeof validate.state?.run === 'string' && validate.state.run.trim() !== '') caps.state = true;
    if (validate.tenant !== undefined || validate.tenantEnv !== undefined || validate.ensureTenant !== undefined)
      caps.tenant = true;
    if (typeof env.watch?.observe === 'string' && env.watch.observe.trim() !== '') caps.observe = true;
  }
  return caps;
}

/**
 * Why a step of this kind is a person's, naming the configuration that would have made it the
 * fleet's — never "unsupported". An operator meeting a check every step of which came back to them
 * is entitled to read which block they have not written. Null is a step the fleet carries.
 */
function stepFault(kind: ValidationStepKind, caps: StepCapabilities): string | null {
  switch (kind) {
    case 'manual':
      return 'a manual step is a person’s by definition — it is the thing the fleet cannot do.';
    case 'browser':
      // It navigates, uploads and clicks, so it acts on the environment; and the harness never
      // generates or infers a tenant, so a step that writes with none has nowhere to write.
      if (!caps.browser)
        return 'no environment declares a "validate.browser" block, so nothing here can drive the application.';
      if (!caps.tenant)
        return (
          'a browser step acts on the environment and no environment names a tenant — a literal "validate.tenant", ' +
          'a "validate.tenantEnv" naming the variable that carries one, or a "validate.ensureTenant" command.'
        );
      return null;
    case 'suite':
    case 'screenshot':
      return caps.browser
        ? null
        : 'no environment declares a "validate.browser" block, so nothing here runs the project’s browser suite.';
    case 'state':
      return caps.state
        ? null
        : 'no environment declares a "validate.state.run" command, so nothing here reads the deployed store.';
    case 'signal':
    case 'measure':
      return caps.observe
        ? null
        : 'no environment declares a "watch.observe" command, so nothing here reads logs, error records or metrics.';
  }
}

interface DeclaredStep {
  kind: ValidationStepKind;
  do: string;
  area?: string | undefined;
  when?: 'inline' | 'deferred' | undefined;
}

/**
 * The authored steps with their assignment resolved. `when` is the author's for a `manual` step —
 * inline and deferred read identically in a list and are not the same thing — and is `inline` for
 * every other kind, which is what "in order" means for a step that runs.
 */
export function resolveSteps(declared: readonly DeclaredStep[], caps: StepCapabilities): ValidationStep[] {
  return declared.map((step) => {
    const fault = stepFault(step.kind, caps);
    return {
      kind: step.kind,
      do: step.do,
      area: step.kind === 'suite' ? (step.area ?? null) : null,
      when: step.kind === 'manual' ? (step.when ?? 'inline') : 'inline',
      actor: fault === null ? ('fleet' as const) : ('human' as const),
      why: fault,
    };
  });
}

/**
 * The check's area: the first `suite` step that names one, and nothing else. It is no longer
 * inherited from the `coverage` of a test part the check happens to `covers` — inheritance made a
 * check automatable by accident, a `covers` entry being a bibliography rather than a decision about
 * what runs. → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
 */
export function stepArea(steps: readonly ValidationStep[]): string | null {
  for (const step of steps) {
    if (step.kind === 'suite' && step.area !== null && step.area !== '') return step.area;
  }
  return null;
}

/**
 * Where a fleet dispatch stops. An **inline** person's step segments the check: no agent holds a
 * browser session across a person's day, so a check carrying one is really two runs with a wait
 * between them, and the dispatch runs as far as the boundary and hands back with what it has.
 *
 * A **deferred** person's step costs the sequence nothing and is not a boundary — the run completes
 * and somebody looks afterwards.
 * → docs/spec/20-validation.md#an-inline-person-and-a-deferred-one-are-not-the-same-step
 */
export function segmentBoundary(steps: readonly ValidationStep[]): number | null {
  const at = steps.findIndex((step) => step.actor === 'human' && step.when === 'inline');
  return at === -1 ? null : at;
}

/**
 * Whether the fleet can carry this check's first segment at all, and so whether dispatching it means
 * anything. A check with **no** steps answers null — there is nothing but the planner's nomination
 * to go on there, which is `fleetCandidate`'s remaining meaning and the operator's press to settle.
 *
 * A first step that is already a person's is the check that can never execute: dispatched, held,
 * blocking nothing. It is the quietest way for a check to be lost, so it answers false and the
 * dispatch rule declines rather than sending an agent to sit in front of it.
 */
export function fleetCanStart(steps: readonly ValidationStep[]): boolean | null {
  if (steps.length === 0) return null;
  return steps[0]?.actor === 'fleet';
}
