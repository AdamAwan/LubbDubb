import { useState } from 'react';
import { api } from '../api.js';
import type { WorldSnapshot } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';

/**
 * The "make the world move" panel. Since v1 runs on a FakeConnector, this is how
 * you simulate the outside world: a CI failure, a review comment, a new story, a
 * meeting. Each injection provokes an immediate dispatch cycle server-side. Every
 * button spins while its injection is in flight so the click reads as "saving".
 */
export function InjectPanel({ onInjected, world }: { onInjected: () => void; world: WorldSnapshot }) {
  const [raw, setRaw] = useState('');
  const [open, setOpen] = useState(false);
  const rawSubmit = useAsyncAction();

  const inject = async (event: unknown) => {
    await api.inject(event);
    onInjected();
  };

  const nextPr = (world.pullRequests.at(-1)?.number ?? 40) + 1;
  const firstPr = world.pullRequests[0]?.number ?? nextPr;
  const nextIssue = (world.issues.at(-1)?.number ?? 100) + 1;
  const today = new Date();
  const inTwoHours = new Date(today.getTime() + 2 * 3600_000).toISOString();

  return (
    <div className="inject">
      <span className="inject-label">Inject event:</span>
      <AsyncButton
        onClick={() =>
          inject({ kind: 'new_pr', number: nextPr, title: `Feature PR #${nextPr}`, branch: `feature/pr-${nextPr}` })
        }
      >
        + PR #{nextPr}
      </AsyncButton>
      <AsyncButton onClick={() => inject({ kind: 'ci_failed', prNumber: firstPr })}>
        CI failed on #{firstPr}
      </AsyncButton>
      <AsyncButton
        onClick={() =>
          inject({
            kind: 'pr_comment',
            prNumber: firstPr,
            author: 'reviewer',
            body: 'Can you rename this variable and add a test?',
          })
        }
      >
        Comment on #{firstPr}
      </AsyncButton>
      <AsyncButton
        onClick={() =>
          inject({ kind: 'new_issue', number: nextIssue, title: `Bug report #${nextIssue}`, labels: ['bug'] })
        }
      >
        + Issue #{nextIssue}
      </AsyncButton>
      <AsyncButton onClick={() => inject({ kind: 'pr_approved', prNumber: firstPr })}>Approve #{firstPr}</AsyncButton>
      <AsyncButton onClick={() => inject({ kind: 'pr_mergeable', prNumber: firstPr })}>
        Mergeable #{firstPr}
      </AsyncButton>
      <AsyncButton
        onClick={() => inject({ kind: 'pr_mergeable', prNumber: firstPr, mergeable: false, mergeableState: 'dirty' })}
      >
        Conflict #{firstPr}
      </AsyncButton>
      <AsyncButton onClick={() => inject({ kind: 'new_story', title: 'Add password reset flow' })}>+ Story</AsyncButton>
      <AsyncButton
        onClick={() =>
          inject({
            kind: 'meeting',
            title: 'Architecture review',
            startsAt: inTwoHours,
            prepDocs: ['design.md', 'ADR-014'],
          })
        }
      >
        + Meeting
      </AsyncButton>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide raw' : 'Raw JSON'}
      </button>
      {open && (
        <form
          className="raw"
          onSubmit={(e) => {
            e.preventDefault();
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              alert('Invalid JSON');
              return;
            }
            void rawSubmit.run(() => inject(parsed));
          }}
        >
          <input
            placeholder='{"kind":"ci_failed","prNumber":42}'
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <SubmitButton phase={rawSubmit.phase} className="primary">
            Inject
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
