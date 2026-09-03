import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { Icon } from './icons.js';

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
 * holds it. It is the hover and never a drawn label: it changes under the pointer
 * every few minutes, and a chip whose width moves on its own drags every slot
 * after it. Absent, the hover says what the chip is rather than nothing.
 *
 * **A glyph, and no words — the icon set's one exception.** `Icon`'s rule is that
 * a glyph never appears without its label, because a glyph alone is a quiz; this
 * chip is what the rule is written against and it earns the exception on two
 * counts. It is not a control an operator has to *find* — it appears in a fixed
 * slot on rows they are already reading, next to the checks, and its job is to be
 * countable down a column rather than read. And it repeats: `agent on it` written
 * out eight times down a rack is eight copies of one sentence, which is how the
 * one row where it *is* news stops standing out. The pulse is the signal, the
 * glyph says which kind of "now" this is, and the sentence is the `aria-label` and
 * the `title` — which is what a screen reader and a pointer each ask for.
 *
 * `play` and not `robot`: the latter means *whose reading this is* on the goal
 * header's verdict chip, and an agent working is a different claim.
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
  const said = note ?? 'An agent is working this — open its transcript';
  return (
    <button
      type="button"
      className="cn-onit"
      onClick={() => actions.select(agentId)}
      title={said}
      aria-label={`Agent on it — ${said}`}
    >
      <i className="cn-onit-dot">
        <Icon name="play" size={11} />
      </i>
    </button>
  );
}
