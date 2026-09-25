// → docs/spec/14-persistence.md

import { TASKS_SCHEMA } from './schema/tasks.js';
import { JOBS_SCHEMA } from './schema/jobs.js';
import { SCHEDULES_SCHEMA } from './schema/schedules.js';
import { PRIORITY_SCHEMA } from './schema/priority.js';
import { PROFILE_OVERRIDES_SCHEMA } from './schema/profileOverrides.js';
import { PAUSES_SCHEMA } from './schema/pauses.js';
import { AGENTS_SCHEMA } from './schema/agents.js';
import { REMEDIES_SCHEMA } from './schema/remedies.js';
import { HUMAN_TASKS_SCHEMA } from './schema/humanTasks.js';
import { ISSUE_VERDICTS_SCHEMA } from './schema/issueVerdicts.js';
import { INSTRUCTIONS_SCHEMA } from './schema/instructions.js';
import { SCRATCH_SCHEMA } from './schema/scratch.js';
import { PLANS_SCHEMA } from './schema/plans.js';
import { TRANSCRIPTS_SCHEMA } from './schema/transcripts.js';
import { ESCALATIONS_SCHEMA } from './schema/escalations.js';
import { LANDINGS_SCHEMA } from './schema/landings.js';
import { BRANCH_REAPS_SCHEMA } from './schema/branchReaps.js';
import { ENVIRONMENTS_SCHEMA } from './schema/environments.js';
import { WATCHES_SCHEMA } from './schema/watches.js';
import { REMOTE_VALIDATION_SCHEMA } from './schema/remoteValidation.js';
import { PR_WATCH_SEEDS_SCHEMA } from './schema/prWatchSeeds.js';
import { WORK_ITEM_LINKS_SCHEMA } from './schema/workItemLinks.js';
import { REVIEW_WAITS_SCHEMA } from './schema/reviewWaits.js';
import { PR_ASSIGN_ASKS_SCHEMA } from './schema/prAssignAsks.js';
import { PR_REVIEWS_SCHEMA } from './schema/prReviews.js';
import { PR_REVIEW_ROUTES_SCHEMA } from './schema/prReviewRoutes.js';
import { PR_SPLITS_SCHEMA } from './schema/prSplits.js';
import { PR_REVIEW_EXTERNALS_SCHEMA } from './schema/prReviewExternals.js';
import { PR_THREAD_REOPENS_SCHEMA } from './schema/prThreadReopens.js';
import { PR_REPLIES_SCHEMA } from './schema/prReplies.js';
import { PR_THREAD_LABELS_SCHEMA } from './schema/prThreadLabels.js';
import { PR_ARCHIVE_SCHEMA } from './schema/prArchive.js';
import { DECISIONS_SCHEMA } from './schema/decisions.js';
import { WORLD_SCHEMA } from './schema/world.js';
import { ERRORS_SCHEMA } from './schema/errors.js';
import { GRAPH_SCHEMA } from './schema/graph.js';
import { BUG_FILINGS_SCHEMA } from './schema/bugFilings.js';
import { RUN_SCHEMA } from './schema/runs.js';
import { VALIDATION_SCHEMA } from './schema/validation.js';
import { TICKETS_SCHEMA } from './schema/tickets.js';
import { SEQUENCES_SCHEMA } from './schema/sequences.js';
import { UPGRADES_SCHEMA } from './schema/upgrades.js';
import { PETS_SCHEMA } from './schema/pets.js';
import { LOCAL_RUNS_SCHEMA } from './schema/localRuns.js';
import { SURFACE_REACH_SCHEMA } from './schema/surfaceReach.js';
import { API_ERRORS_SCHEMA } from './schema/apiErrors.js';
import { MCP_CALLS_SCHEMA } from './schema/mcpCalls.js';
import { POOL_SCHEMA } from './schema/pool.js';
import { LOCAL_VALIDATIONS_SCHEMA } from './schema/localValidations.js';
import { RATE_LIMITS_SCHEMA } from './schema/rateLimits.js';
import { OBSTACLES_SCHEMA } from './schema/obstacles.js';
import { EJECTIONS_SCHEMA } from './schema/ejections.js';
import { PREDICTIONS_SCHEMA } from './schema/predictions.js';
import { GOAL_CRITERIA_SCHEMA } from './schema/goalCriteria.js';
import { PR_DESCRIPTIONS_SCHEMA } from './schema/prDescriptions.js';

export const SCHEMA =
  TASKS_SCHEMA +
  JOBS_SCHEMA +
  SCHEDULES_SCHEMA +
  PRIORITY_SCHEMA +
  PROFILE_OVERRIDES_SCHEMA +
  PAUSES_SCHEMA +
  AGENTS_SCHEMA +
  REMEDIES_SCHEMA +
  HUMAN_TASKS_SCHEMA +
  ISSUE_VERDICTS_SCHEMA +
  INSTRUCTIONS_SCHEMA +
  SCRATCH_SCHEMA +
  PLANS_SCHEMA +
  TRANSCRIPTS_SCHEMA +
  ESCALATIONS_SCHEMA +
  LANDINGS_SCHEMA +
  BRANCH_REAPS_SCHEMA +
  ENVIRONMENTS_SCHEMA +
  WATCHES_SCHEMA +
  REMOTE_VALIDATION_SCHEMA +
  PR_WATCH_SEEDS_SCHEMA +
  WORK_ITEM_LINKS_SCHEMA +
  REVIEW_WAITS_SCHEMA +
  PR_ASSIGN_ASKS_SCHEMA +
  PR_REVIEWS_SCHEMA +
  PR_REVIEW_ROUTES_SCHEMA +
  PR_SPLITS_SCHEMA +
  PR_REVIEW_EXTERNALS_SCHEMA +
  PR_THREAD_REOPENS_SCHEMA +
  PR_REPLIES_SCHEMA +
  PR_THREAD_LABELS_SCHEMA +
  PR_ARCHIVE_SCHEMA +
  DECISIONS_SCHEMA +
  WORLD_SCHEMA +
  ERRORS_SCHEMA +
  GRAPH_SCHEMA +
  BUG_FILINGS_SCHEMA +
  RUN_SCHEMA +
  VALIDATION_SCHEMA +
  TICKETS_SCHEMA +
  SEQUENCES_SCHEMA +
  UPGRADES_SCHEMA +
  PETS_SCHEMA +
  LOCAL_RUNS_SCHEMA +
  SURFACE_REACH_SCHEMA +
  API_ERRORS_SCHEMA +
  MCP_CALLS_SCHEMA +
  POOL_SCHEMA +
  LOCAL_VALIDATIONS_SCHEMA +
  RATE_LIMITS_SCHEMA +
  OBSTACLES_SCHEMA +
  EJECTIONS_SCHEMA +
  PREDICTIONS_SCHEMA +
  GOAL_CRITERIA_SCHEMA +
  PR_DESCRIPTIONS_SCHEMA;
