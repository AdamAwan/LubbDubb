import type { ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';

// → docs/spec/37-bot-prs.md#one-put-on-you-that-is-in-trouble

export function botPrBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const pr = view.state.world.pullRequests.find((p) => p.number === row.prNumber);
  if (!pr) return null;
  const n = pr.number;
  return (
    <>
      <p>
        <strong>{pr.title}</strong>
      </p>
      <p className="cn-tick">
        {pr.author ?? 'A bot'} raised <Ref to={`pr:${n}`} /> and it is on you, but the fleet is leaving it alone. Hand
        it to the fleet to fix, close it and wait for the next bump, or step off it.
      </p>
      <ButtonRow bar>
        <AsyncButton
          tone="primary"
          size="small"
          usage="bot-pr.accept"
          onClick={() => actions.setPrWatched(n, true)}
          pendingLabel="Watching…"
          title="Tag it for watching, so the fleet works it like its own"
        >
          Watch it
        </AsyncButton>
        <AsyncButton
          tone="danger"
          size="small"
          usage="bot-pr.abandon"
          onClick={() => actions.closeBotPr(n)}
          pendingLabel="Closing…"
          title="Close it (abandon on Azure); the bot raises the next version"
        >
          Abandon
        </AsyncButton>
        <AsyncButton
          size="small"
          usage="bot-pr.reject"
          onClick={() => actions.unclaimBotPr(n)}
          pendingLabel="Stepping off…"
          title="Take yourself off it on the provider"
        >
          Unassign me
        </AsyncButton>
      </ButtonRow>
    </>
  );
}
