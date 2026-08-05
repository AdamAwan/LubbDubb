// What the demo backend answers, route by route, for every route the real server
// declares in `src/server/app.ts`.
//
// `demoBackend` dispatches by method name, not by URL, so the correspondence
// between the two surfaces was held nowhere — add a route, wire it into
// `web/src/api.ts`, forget the demo arm, and format, lint, both typecheckers,
// knip and the suite all stay green while the Pages build breaks after deploy.
// This table is that correspondence written down; `test/demoBackend.test.ts`
// holds it against the real route table in both directions.
//
// **Full behavioural fidelity is not what is owed.** A route the demo answers
// with a constant, or refuses outright, is a legitimate entry — the demo has no
// tracker, no worktrees and no `loadConfig`, and pretending otherwise would
// teach the controls wrong. What must not be possible is a route the demo has
// never heard of. That is what `absent` is for: it records the decision instead
// of leaving a gap that reads the same as an oversight.
//
// Kept to plain data for the same reason as its neighbour: nothing imports this
// module in either build, so Rollup drops it and it costs the bundle nothing.
import { demoApi } from './demoBackend.js';

/**
 * `METHOD path` — the path exactly as `app.ts` declares it, params and all —
 * against either the `demoApi` method that answers it, or the reason the demo
 * has no arm for it.
 */
export const DEMO_ROUTES: Record<string, keyof typeof demoApi | { absent: string }> = {
  // -- The snapshot and the streams ----------------------------------------
  'GET /api/state': 'getState',
  'GET /api/agents/:id/transcript': 'getTranscript',

  // -- Read-on-open panels --------------------------------------------------
  'GET /api/work': 'getWorkRoots',
  'GET /api/work/:ref': 'getWorkSubtree',
  'GET /api/retrospectives/:ref': 'getRetrospective',
  'GET /api/scratchpads/:ref': 'getScratchpad',
  'GET /api/prompts': 'getPrompts',
  'GET /api/config': 'getConfig',

  // -- The world, and the operator's overrides of it ------------------------
  'POST /api/inject': 'inject',
  'POST /api/pulse': 'pulse',
  'POST /api/errors/clear': 'clearErrors',
  'POST /api/control': 'setControl',
  'POST /api/prs/:number/exclude': 'setPrExcluded',
  'POST /api/issues/:number/watch': 'setIssueWatched',
  'POST /api/issues/:number/conclusion': 'setIssueConclusion',
  'POST /api/issues/:number/assay': 'setIssueAssay',
  'POST /api/issues/:number/dismiss-run': 'dismissRun',

  // -- Plans ----------------------------------------------------------------
  'POST /api/plans/:id/replan': 'replan',
  'POST /api/plans/:id/abandon': 'abandonPlan',
  'POST /api/plans/:id/discuss': 'discussPlan',
  'POST /api/plans/:id/discuss/end': 'endPlanDiscussion',

  // -- Jobs and the queue ---------------------------------------------------
  'POST /api/jobs': 'launchJob',
  'POST /api/jobs/:id/cancel': 'cancelJob',
  'POST /api/upnext/order': 'reorderUpNext',

  // -- Findings -------------------------------------------------------------
  'POST /api/findings/:id/promote': 'promoteFinding',
  'POST /api/findings/:id/file': 'fileFinding',
  'POST /api/findings/:id/dismiss': 'dismissFinding',

  // -- The inbox ------------------------------------------------------------
  'POST /api/escalations/:id/answer': 'answerEscalation',
  'POST /api/escalations/:id/dismiss': 'dismissEscalation',
  'POST /api/escalations/:id/permission': 'decidePermission',
  'POST /api/proposals/:id/accept': 'acceptProposal',
  'POST /api/proposals/:id/reject': 'rejectProposal',
  'POST /api/recovery/:id': 'decideRecovery',

  // -- The fleet ------------------------------------------------------------
  'POST /api/agents/:id/respond': 'respondAgent',
  'POST /api/agents/:id/kill': 'killAgent',
  'POST /api/agents/:id/complete': 'completeAgent',
  'POST /api/agents/:id/interrupt': 'interruptAgent',

  // -- The work graph's two verdicts ----------------------------------------
  'POST /api/work/:ref/file': 'fileWorkItem',
  'POST /api/work/:ref/ignore': 'setWorkItemIgnored',
  // `ignored: false` is a DELETE because the store's undo is a delete — one
  // representation of "not ignored". Both halves are the same demo method.
  'DELETE /api/work/:ref/ignore': 'setWorkItemIgnored',

  // -- Declared, and deliberately unanswered --------------------------------
  'GET /artifacts/:id': {
    absent:
      'A top-level browser navigation, not a fetch — it never goes through `api`. The demo world ' +
      'ships no flags and an empty `artifactUrls`, so no chip in it opens one.',
  },
  'GET /api/health': {
    absent: 'A liveness probe for whatever supervises the process. The cockpit never calls it.',
  },
  'POST /api/issues/:number/delivered': {
    absent:
      'No cockpit control calls it — the delivery verdict is written by the assessor and the ' +
      'operator arm is reached by hand. Nothing in the demo can reach it either.',
  },
  'POST /api/issues/:number/shortfall': {
    absent: 'The other half of the same pair, and unreachable from the cockpit for the same reason.',
  },
};
