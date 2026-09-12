import type { ErrorRecorder } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Issue, IssueAppraisal, WorldSnapshot } from '../types.js';
import { appraisalHold } from './appraisal.js';

// → docs/spec/06-issue-pickup.md

interface AppraisalDeskDeps {
  store: Store;
  sink: ActionSink;
  errors?: ErrorRecorder;
}

export class AppraisalDesk {
  private readonly lastBody = new Map<string, string>();

  constructor(private readonly deps: AppraisalDeskDeps) {}

  async announce(world: WorldSnapshot): Promise<void> {
    const appraisals = new Map(this.deps.store.verdicts.listAppraisals().map((a) => [a.originRef, a]));
    if (appraisals.size === 0) return;
    for (const issue of world.issues) {
      const appraisal = appraisals.get(`issue:${issue.number}`);
      if (!appraisal || appraisal.verdict !== 'unclear') continue;
      const held = appraisalHold(appraisal, issue) !== null;
      if (!held && appraisal.commentRef === null) continue;
      const body = renderAppraisalComment(appraisal, held);
      if (appraisal.commentRef !== null && body === this.lastBody.get(appraisal.originRef)) continue;
      await this.write(issue, appraisal, body);
    }
  }

  private async write(issue: Issue, appraisal: IssueAppraisal, body: string): Promise<void> {
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issue.number,
        body,
        commentRef: appraisal.commentRef,
      });
      this.lastBody.set(appraisal.originRef, body);
      if (result.ref && result.ref !== appraisal.commentRef)
        this.deps.store.verdicts.setAppraisalComment(appraisal.originRef, result.ref);
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the goal appraisal comment on #${issue.number}: ${(err as Error).message}`,
      });
    }
  }
}

export function renderAppraisalComment(appraisal: IssueAppraisal, held: boolean): string {
  if (!held) {
    return (
      `${MARKER}\n\n**No longer waiting on this.** The description has changed since the questions below ` +
      `were asked, so LubbDubb will look at this item again.\n\n> ${quote(appraisal.summary)}`
    );
  }
  const number = appraisal.originRef.replace(/^issue:/, '');
  const list =
    appraisal.missing.length > 0
      ? `\n\nBefore an agent can start, this ticket needs to say:\n\n${appraisal.missing.map((q) => `- [ ] ${q}`).join('\n')}`
      : '';
  return (
    `${MARKER}\n\n**Nothing is scheduled for this yet — I could not work out what to do from the ` +
    `description.**\n\n> ${quote(appraisal.summary)}${list}\n\n` +
    `**What to do:** edit this item so the description answers the points above. That alone is enough — ` +
    `LubbDubb re-reads it on its next pass, with no button to press. Replies here are not read by the ` +
    `agents, so an answer left in a comment does not restart it.\n\n` +
    `Want a hand? Open the project in Claude Code and run \`/lubbdubb clarify ${number}\`: it reads what ` +
    `the check found, talks it through with you, and drafts the rewrite.\n\n` +
    `Nothing has been rejected and nothing is closed.`
  );
}

const MARKER = '<!-- lubbdubb:appraisal -->\n_LubbDubb goal check_';

function quote(text: string): string {
  return text.trim().replace(/\n/g, '\n> ');
}
