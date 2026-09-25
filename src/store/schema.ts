// → docs/spec/14-persistence.md

import { WORK_SCHEMA } from './schema/work.js';
import { PLAN_SCHEMA } from './schema/plans.js';
import { ENVIRONMENT_SCHEMA } from './schema/environments.js';
import { PULL_REQUEST_SCHEMA } from './schema/pullRequests.js';
import { VALIDATION_AND_TRACKER_SCHEMA } from './schema/validationAndTracker.js';
import { OPERATIONS_SCHEMA } from './schema/operations.js';
import { OBSTACLE_SCHEMA } from './schema/obstacles.js';
import { PREDICTION_SCHEMA } from './schema/predictions.js';

export const SCHEMA =
  WORK_SCHEMA +
  PLAN_SCHEMA +
  ENVIRONMENT_SCHEMA +
  PULL_REQUEST_SCHEMA +
  VALIDATION_AND_TRACKER_SCHEMA +
  OPERATIONS_SCHEMA +
  OBSTACLE_SCHEMA +
  PREDICTION_SCHEMA;
