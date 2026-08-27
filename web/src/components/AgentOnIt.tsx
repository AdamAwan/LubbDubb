import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';

/**
 * An agent is working this **right now** — one chip, wherever that is true.
 *
 * Shared because it is one fact, and the cockpit had been saying it two ways: the
 * rack drew it in the slot its CI checks would be in, and a plan part drew
 * `open the agent ↗` inside its dependency line. Two wordings, two weights and two
 * hovers for the same sentence, which is how a reader learns to treat one of them
 * as furniture. The pulse belongs to whichever surface has the fact.
 *
 * It is a **control**, not a `<Ref>`: an agent's drawer is a place in the cockpit
 * rather than a reference, and `<Ref>` resolves things the *provider* can address.
 * → docs/spec/17-cockpit.md#links
 *
 * `note` is the agent's own last answer to "what are you doing", where the caller
 * holds it. It is the hover and never the label: it changes under the pointer
 * every few minutes, and a chip whose width moves on its own drags every slot
 * after it. Absent, the hover says what the chip is rather than nothing.
 */
export function AgentOnIt({
  agentId,
  note,
  actions,
}: {
  agentId: string;
  note?: string | null;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <button
      type="button"
      className="cn-onit"
      onClick={() => actions.select(agentId)}
      title={note ?? 'An agent is working this — open its transcript'}
    >
      <i className="cn-onit-dot" />
      agent on it
    </button>
  );
}
