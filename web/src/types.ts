/**
 * The cockpit's names for the wire contract.
 *
 * This file used to be a ~840-line hand-maintained mirror of what
 * `buildStateSnapshot` happened to infer, and nothing ever related the two: the
 * producer had no declared return type, this had no producer, and they met at one
 * unchecked `json<AppState>(r)` assertion. It also widened the server's unions
 * three different ways with no rule for which — `Job.status` to `string` (so
 * `j.status === 'queued'` was legal against any string and would silently count
 * zero after a rename), `Proposal.action` to an index-signature bag, and
 * `Finding.status` re-declared member-by-member (so a sixth member server-side
 * left this a silently-narrowing subset).
 *
 * All of it is now one declaration in `src/wire.ts`, which this re-exports. The
 * import is **type-only in both directions**, so nothing about the "web bundle
 * imports no server code" constraint changes: `import type` is erased before the
 * SPA is bundled, and `test/wireContract.test.ts` asserts that structurally.
 *
 * The aliases below are the only translation, and they are aliases rather than
 * copies precisely so they cannot drift: `AppState` is what the cockpit has
 * always called the polled snapshot, and the `*View` names say "this is a payload
 * shape, not the harness's own record" at 40 import sites.
 */
export type {
  Agent,
  AgentAskQuestion,
  AgentFile,
  AgentFlag,
  BugFiling,
  CiPolicyDescription,
  CiRuleDescription,
  CockpitDecision,
  Decision,
  DispatchRule,
  ErrorLogEntry,
  Escalation,
  FileOverlap,
  Finding,
  HumanTask,
  Issue,
  IssueRelative,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  OpenPullRequest,
  OrphanedWork,
  Plan,
  PlanPart,
  PolicyKindDescription,
  Proposal,
  PullRequest,
  QueueItem,
  RecoveryVerdict,
  RunningConfigGroup,
  SpendGoal,
  SpendInsights,
  SpendPhase,
  SpendPhaseTotal,
  SpendRun,
  Stack,
  StackLanding,
  StackLandingView,
  StackRung,
  Task,
  UpcomingPlan,
  WorldEvent,
  WorldEventKind,
  CockpitState as AppState,
  CockpitUsage as UsageSnapshot,
  CockpitWorld as WorldSnapshot,
  PromptTemplateDescription as PromptTemplateView,
  Retrospective as RetrospectiveView,
  ScratchEntry as ScratchEntryView,
  UnrecordedWork as UnrecordedWorkView,
  WorkNode as WorkNodeView,
} from '../../src/wire.js';
