import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';

/**
 * What the shell hands the floor: a finished view-model and the enumerated set of
 * things the operator can do.
 *
 * The pair is a named type rather than an inline shape because it is threaded
 * through every desk and panel below `FactoryRoot`, and because it is the seam
 * that keeps the floor off the network — `actions` is the only way out, and
 * `test/factoryFloor.test.ts` asserts nothing under `factory/` imports `api.js`.
 */
export interface FloorProps {
  view: CockpitView;
  actions: CockpitActions;
}
