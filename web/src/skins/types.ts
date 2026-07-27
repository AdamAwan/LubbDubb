import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';

export interface SkinProps {
  view: CockpitView;
  actions: CockpitActions;
}

/**
 * A skin owns its whole layout: it is handed a finished view-model and renders
 * whatever tree it likes, rather than overriding slots in a shared page. The
 * treatments worth having redraw the data (a queue as a belt feeding machines)
 * rather than rearrange the panels, and a slot contract wide enough for that is
 * no longer a contract.
 *
 * What keeps that from becoming N divergent cockpits is the shared/skinned split:
 * anything with an async flow, a refusal rule or hold semantics — the drawer, the
 * escalation answer flow, recovery — lives in `components/` and is styled only
 * through tokens, so it has exactly one implementation. A skin draws; it does not
 * decide.
 */
export interface Skin {
  /** Stable id: the `data-skin` attribute value and the localStorage key's value. */
  id: string;
  /** Name shown in the picker. */
  label: string;
  /** One line on what the treatment is, for the picker's title. */
  description: string;
  Root: (props: SkinProps) => JSX.Element;
}
