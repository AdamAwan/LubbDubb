/**
 * `captured` is *captured, waiting to be looked at*: a `screenshot` step took the picture and
 * attached it, and nobody has judged it yet. It is deliberately **not** a reading — it goes green or
 * red only when a person records one, which is [a result is declared, never
 * derived](docs/spec/20-validation.md#states) applied exactly as written.
 *
 * A row from before the state existed reads `unrun`, and must: `checkStateOf` narrows anything it
 * does not recognise to `unrun`, so the old rows land on the state that means *nobody has got to
 * it* rather than on the one that means *there is an image here for you*.
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 *
 * `declined` is the operator's own verdict at the accept gate: they read the row, said no to it, and
 * accepted the rest of the set. It is settled — never assembled onto a sheet, never dispatched for,
 * never owed to a person — and it is not a pass: it counts against the goal's flag exactly as
 * `deferred` does, with the reason they gave beside it.
 * → docs/spec/20-validation.md#declining-a-single-row
 */
export type ValidationCheckState = 'unrun' | 'passed' | 'failed' | 'waived' | 'deferred' | 'captured' | 'declined';

/**
 * One row an operator strikes out of the set they are accepting, by the letter the ask drew it under.
 * The reason is required for `validation_plan`'s reason: null with no account of itself is the
 * failure that document keeps meeting. → docs/spec/20-validation.md#declining-a-single-row
 */
export interface CheckDecline {
  letter: string;
  reason: string;
}

export type ValidationCheckActor = 'human' | 'fleet';

/**
 * A step's kind, and the whole of what decides who can carry it. Each one names a thing the
 * deployment either declares or does not: `browser`, `suite` and `screenshot` need an environment's
 * `validate.browser` block, `state` its `state.run`, `signal` and `measure` its `watch.observe`.
 * `manual` is a person's by definition. → docs/spec/20-validation.md#the-test-plan
 */
export type ValidationStepKind = 'browser' | 'suite' | 'screenshot' | 'state' | 'signal' | 'measure' | 'manual';

/**
 * **When** a person's step is taken, which is a different fact from who takes it. A `deferred` step
 * costs the sequence nothing — the run completes and somebody looks afterwards. An `inline` one stops
 * the run where it sits, because no agent holds a browser session across a person's day.
 * → docs/spec/20-validation.md#an-inline-person-and-a-deferred-one-are-not-the-same-step
 */
type ValidationStepWhen = 'inline' | 'deferred';

/**
 * One step of a check's test plan. `kind`, `do`, `area` and `when` are the author's; `actor` and
 * `why` are **read off the configuration** at ingestion and are never the author's to say.
 * → docs/spec/20-validation.md#who-carries-a-step
 */
export interface ValidationStep {
  kind: ValidationStepKind;
  /** What this step does, in the author's words. */
  do: string;
  /** `suite` only: the area of the project's own browser suite this step runs. Sets the check's `area`. */
  area: string | null;
  /**
   * `suite` only: the concrete spec names this step expects the area to run. Null is *the author
   * named no expectation* and is never "expected nothing" — the difference is computed only where
   * there is one. Sets the check's `expects`.
   * → docs/spec/36-remote-validation.md#an-expected-spec-the-runner-does-not-offer
   */
  expects: string[] | null;
  when: ValidationStepWhen;
  /**
   * `browser` only: the one-off script's source, run as it stands. It is the browser-shaped member of
   * the query column — unreviewed, tenant-scoped, written for this check and never in a pull request
   * — so it is drawn beside its reading rather than trusted, and swept `remoteValidation.scriptGraceMs`
   * past the goal's delivery. Null is a `browser` step a person drives.
   * → docs/spec/36-remote-validation.md#the-one-off-script
   */
  script: string | null;
  /**
   * When the grace sweep removed the script's source, ISO. It is stamped **where the source was**,
   * which is what "the sweep names what it removed" comes to: a step reading *there was a one-off
   * script here and it is gone* is a different thing from a `browser` step a person always drove, and
   * folding the two would quietly rewrite the history of how a green row was earned. Null is a step
   * whose script is still here, or one that never had one.
   * → docs/spec/36-remote-validation.md#the-one-off-script
   */
  scriptSweptAt: string | null;
  actor: ValidationCheckActor;
  /** Why it is a person's, naming the configuration that would have made it the fleet's. Null where the fleet carries it. */
  why: string | null;
}

/** What an OK would run on a page, by kind, and how many of its queries it approves. */
export interface OkScope {
  checks: number;
  queries: number;
  approvals: number;
}

/**
 * Five different facts, and the whole point of keeping them apart is that one must never be assumed
 * from evidence that supports another. `spec` is **a reviewed spec ran against a real environment
 * and its report said so** — stronger than `agent`, because no model read anything, and different
 * from `operator`, because nobody watched it. `script` is the same machinery with the review taken
 * out: a one-off script written for this check alone, never in a pull request and read by nobody. It
 * is **never folded with `spec`** in any reader — an operator counting green rows would otherwise be
 * told a throwaway and a reviewed spec are the same evidence.
 * → docs/spec/36-remote-validation.md#what-a-spec-reading-is-worth, [the one-off script](docs/spec/36-remote-validation.md#the-one-off-script)
 */
export type ValidationCheckResultBy = 'operator' | 'agent' | 'desktop' | 'spec' | 'script';

export interface ValidationCheck {
  originRef: string;
  id: string;
  letter: string;
  seq: number;
  title: string;
  do: string;
  expect: string;
  /**
   * What must come back for a pass to count — the evidence the author demanded in advance, in prose.
   * Null is *none was demanded*, which is every check written before the field and every check whose
   * assertion is the whole of its evidence. It is not a second `expect`: `expect` is what has to be
   * true and this is what has to be **handed back** to show it.
   * → docs/spec/20-validation.md#proof
   */
  proof: string | null;
  uses: string[];
  covers: string[];
  /** One line: why this check is the right proof of what it checks. Absent or null is none written. → docs/spec/20-validation.md#rationale */
  rationale?: string | null;
  fleetCandidate: boolean;
  candidateWhy: string | null;
  actor: ValidationCheckActor;
  handbackNote: string | null;
  state: ValidationCheckState;
  resultNote: string | null;
  resultBy: ValidationCheckResultBy | null;
  resultAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  deferUntil: string | null;
  supersededReason: string | null;
  revision: ValidationRevision | null;
  amendedAt: string | null;
  amendNote: string | null;
  /**
   * The check's test plan: one ordered journey through the delivered goal. Empty is **no steps**,
   * which is every check written before the column existed and every check whose author declared
   * only prose — `fleetCandidate` keeps its meaning there and nowhere else.
   * → docs/spec/20-validation.md#the-test-plan
   */
  steps: ValidationStep[];
  /**
   * The screen a `screenshot` step handed back, as a **file name** in the goal's validation directory
   * — never a path and never an artefact URL. The difference from the run's artefacts is retention:
   * the publish command's report is swept on the runner's own schedule, and a screenshot somebody
   * still has to look at outlives the run that took it. Null is no capture.
   * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
   */
  capture: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationRevision {
  title: string;
  do: string;
  expect: string;
  /**
   * The evidence the replaced wording demanded. Null is both *it demanded none* and *this revision
   * was recorded before the field existed*, which read the same way: there is no prior demand to
   * show. → docs/spec/20-validation.md#proof
   */
  proof: string | null;
  state: ValidationCheckState | null;
  note: string | null;
}

export interface ValidationCheckInput {
  id: string;
  seq: number;
  title: string;
  do: string;
  expect: string;
  /** The evidence a pass must hand back, or null where none was demanded. → {@link ValidationCheck.proof} */
  proof: string | null;
  uses: string[];
  covers: string[];
  rationale?: string | null;
  fleetCandidate: boolean;
  candidateWhy: string | null;
  /** The resolved test plan. Omitted and empty are the same fact: this check declares no steps. */
  steps?: ValidationStep[];
}

export type ValidationCheckAmendment = Omit<ValidationCheckInput, 'seq'>;

export interface ValidationAmendment {
  checks: ValidationCheckAmendment[];
  withdraw: { id: string; reason: string }[];
  resources: ValidationResourceInput[];
  note: string;
}

export interface ValidationAmendResult {
  added: ValidationCheck[];
  reworded: ValidationCheck[];
  unchanged: string[];
  withdrawn: string[];
  unknown: string[];
}

/**
 * A goal's validation plan, either half of it. The plan document writes the `hint` — prose intent,
 * binding nothing — and the validation planner writes the rest after delivery: its account of where
 * it departed from that hint, and, where it declared nothing, why nothing was worth running.
 *
 * `authoredAt` is the fact nothing else holds. An empty check set is a legitimate answer and is
 * indistinguishable from a planner that never ran, so sheet assembly waits on this stamp rather
 * than on a check count. → docs/spec/20-validation.md#when-the-check-set-is-written
 */
export interface ValidationPlanRecord {
  originRef: string;
  hint: string | null;
  note: string | null;
  emptyReason: string | null;
  authoredAt: string | null;
  /**
   * The operator's accept on the authored set. Null is a set that is authored and still a proposal:
   * the rows exist and nothing reads them as work yet — no sheet assembles off them and rule
   * `validate-check` dispatches nothing. → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
   */
  releasedAt: string | null;
}

/**
 * One check as it was **proposed**, carried on `propose_validation_plan` and drawn by the ask.
 *
 * Stored on the action rather than re-read from the rows at draw time, for `planCaveats`' reason one
 * subsystem over: the verdict is on what was put in front of the operator. An amendment that lands
 * between the ask and the answer must not silently change what they are agreeing to.
 * → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
 */
export interface ProposedCheck {
  letter: string;
  title: string;
  expect: string;
  /** What a pass must hand back. Empty is *none demanded* — the card draws nothing. */
  proof: string;
  /** Why this check proves its criteria. Empty or absent is none written. */
  rationale?: string;
  steps: { kind: ValidationStepKind; do: string; actor: ValidationCheckActor; why: string | null }[];
  /** The planner's nomination, with its reason. Advice: the hand-over is still the operator's. */
  fleetCandidate: boolean;
  candidateWhy: string | null;
  /** Its first step is a person's, so the fleet can never start it. */
  fleetBlocked: boolean;
  /** It carries a `state` step, whose query this accept does not approve. */
  carriesQuery: boolean;
}

export interface ValidationResourceInput {
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  provided: boolean;
}

export type ValidationResourceKind = 'fixture' | 'access' | 'reference' | 'data';

export interface ValidationResource {
  originRef: string;
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  provided: boolean;
  humanTaskId: string | null;
}

export interface ValidationVerdict {
  state: 'clear' | 'flagged';
  total: number;
  passed: number;
  failed: number;
  unrun: number;
  deferred: number;
  waived: number;
  /**
   * Captured and waiting to be looked at. Its own counter rather than folded into `unrun`: the two
   * ask different things of the person reading them — *nobody has got to it* against *there is an
   * image here and the only thing left is your eyes* — and `total` is the sum of the six.
   * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
   */
  captured: number;
  /**
   * Declined by the operator at the accept gate. Counted apart from `waived` because the two are
   * different acts at different moments — *I am not accepting this row into the set* against *this
   * one does not need running after all* — and folding them would let the cheap word at the gate do
   * the expensive word's job at close-out. It counts against `clear` exactly as `deferred` does, and
   * `total` is the sum of the seven. → docs/spec/20-validation.md#declining-a-single-row
   */
  declined: number;
}
