import type { ErrorRecorder } from '../errorLog.js';
import { seedPrWatch } from '../pr/prWatchDesk.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { LessonDraft, LessonFix, LessonOutcome, Task } from '../types.js';
import { lessonPrBody, lessonTicketBody, type RefUrl } from './evidence.js';
import { lessonBranch, lessonDraftId, lessonPrsForGroup, lessonSearchKey } from './lessonOrigin.js';
import { othersLessonPrs, type LessonPrReading } from './lessonPrs.js';

// → docs/spec/41-repo-lessons.md#the-outcome

export interface LessonConcludeInput {
  outcome: LessonOutcome;
  fix: LessonFix | null;
  title: string;
  summary: string;
  reason: string;
}

type Concluded =
  | { ok: true; outcome: 'pull_request'; prNumber: number; branch: string }
  | { ok: true; outcome: 'ticket'; ticketRef: string }
  | { ok: true; outcome: 'nothing'; coveredBy?: string }
  | { ok: false; error: string };

interface LessonOutcomeDeps {
  store: Store;
  sink: ActionSink;
  filing: TicketFiler;
  refUrl: RefUrl;
  defaultBranch: string;
  watchLabel: string;
  lessonLabel: string;
  /** Every fleet's lesson pull requests, read fresh before one is opened. */
  lessonPrs: LessonPrReading;
  errors?: ErrorRecorder;
}

/** What `lesson_conclude` does: the pull request, the ticket, or the settling — never a body the agent wrote. */
export class LessonOutcomeDesk {
  constructor(private readonly deps: LessonOutcomeDeps) {}

  async conclude(task: Task, input: LessonConcludeInput): Promise<Concluded> {
    const draft = this.ownDraft(task);
    if ('error' in draft) return { ok: false, error: draft.error };
    if (input.outcome === 'nothing') {
      if (input.reason.trim() === '') return { ok: false, error: 'nothing needs a reason: why no fix is right.' };
      this.deps.store.lessons.settle(draft.id, 'nothing', ['dispatched'], {
        fix: input.fix,
        summary: input.summary,
        reason: input.reason,
      });
      return { ok: true, outcome: 'nothing' };
    }
    if (input.fix === null)
      return { ok: false, error: `${input.outcome} needs a fix: code, guard, contradiction or note.` };
    const title = input.title.trim();
    if (title === '') return { ok: false, error: `${input.outcome} needs a title.` };
    if (/#\d/.test(title) || /!\d/.test(title))
      return {
        ok: false,
        error: 'name no pull request or work item in the title: the harness cites every one in the body as a link.',
      };
    const branch = task.branch ?? lessonBranch(draft.id, draft.groupKey);
    if (input.outcome === 'pull_request') {
      const covered = await this.coveredBy(draft);
      if (covered === undefined)
        return {
          ok: false,
          error:
            'Could not read the other lesson pull requests on the repository to check for one already open. Call lesson_conclude again.',
        };
      if (covered !== null) {
        await this.dropBranch(branch);
        this.deps.store.lessons.settle(draft.id, 'nothing', ['dispatched'], {
          fix: input.fix,
          title,
          summary: input.summary,
          reason: `Another lesson pull request for this group was opened first: ${covered}`,
        });
        return { ok: true, outcome: 'nothing', coveredBy: covered };
      }
    }
    return input.outcome === 'pull_request'
      ? this.openPr(draft, branch, { ...input, fix: input.fix, title })
      : this.fileTicket(draft, { ...input, fix: input.fix, title });
  }

  /** Another fleet's open or merged lesson pull request for the draft's group, by URL; undefined when unread. */
  private async coveredBy(draft: LessonDraft): Promise<string | null | undefined> {
    const read = await this.deps.lessonPrs.read();
    if (read === null) return undefined;
    return (
      lessonPrsForGroup(othersLessonPrs(read, [draft]), draft.groupKey).find((pr) => pr.state !== 'closed')?.url ?? null
    );
  }

  private async dropBranch(branch: string): Promise<void> {
    try {
      await this.deps.sink.deleteBranch({ branch });
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `deleting covered lesson branch ${branch} failed: ${(err as Error).message}`,
      });
    }
  }

  private ownDraft(task: Task): LessonDraft | { error: string } {
    const id = lessonDraftId(task.originRef);
    const draft = id === null ? null : this.deps.store.lessons.getDraft(id);
    if (draft === null || draft.taskId !== task.id)
      return {
        error:
          'lesson_conclude is for the agent drafting a repo lesson, and this task is not one. ' +
          'It concludes nothing for any other work.',
      };
    if (draft.status !== 'dispatched')
      return { error: `this lesson is already concluded (${draft.status}); there is nothing more to call.` };
    return draft;
  }

  private async openPr(
    draft: LessonDraft,
    branch: string,
    input: LessonConcludeInput & { fix: LessonFix },
  ): Promise<Concluded> {
    const { store, sink, errors } = this.deps;
    let ref: string | undefined;
    try {
      ref = (
        await sink.createPullRequest({
          branch,
          base: this.deps.defaultBranch,
          title: input.title,
          body: lessonPrBody(draft, input.fix, this.deps.refUrl),
        })
      ).ref;
    } catch (err) {
      errors?.record({ source: 'agent', message: `opening lesson PR ${branch} failed: ${(err as Error).message}` });
      return {
        ok: false,
        error:
          `Opening the lesson pull request failed: ${(err as Error).message}. If your commits are not on the ` +
          `remote, run \`git push -u origin ${branch}\` and call lesson_conclude again. Do not open it by hand.`,
      };
    }
    const prNumber = Number(ref);
    if (ref === undefined || !Number.isInteger(prNumber))
      return { ok: false, error: 'the provider did not say which pull request it opened; call lesson_conclude again.' };
    const recorded = store.lessons.concludePr(draft.id, prNumber, {
      fix: input.fix,
      title: input.title,
      summary: input.summary,
      reason: input.reason,
    });
    if (!recorded)
      errors?.record({
        source: 'agent',
        message: `lesson PR ${String(prNumber)} opened for draft ${draft.id}, which was no longer dispatched`,
      });
    try {
      await sink.setPrLabel({ prNumber, label: this.deps.lessonLabel, present: true });
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `labelling lesson PR ${String(prNumber)} "${this.deps.lessonLabel}" failed: ${(err as Error).message}`,
      });
    }
    await seedPrWatch({ prNumber, branch }, { sink, store, watchLabel: this.deps.watchLabel, errors });
    return { ok: true, outcome: 'pull_request', prNumber, branch };
  }

  private async fileTicket(draft: LessonDraft, input: LessonConcludeInput & { fix: LessonFix }): Promise<Concluded> {
    let ticketRef: string;
    try {
      ticketRef = await this.deps.filing({
        title: input.title,
        body: lessonTicketBody(draft, input, this.deps.refUrl),
        labels: [this.deps.lessonLabel],
        searchKey: lessonSearchKey(draft.groupKey),
      });
    } catch (err) {
      this.deps.errors?.record({ source: 'agent', message: `filing lesson ticket failed: ${(err as Error).message}` });
      return { ok: false, error: `Filing the lesson ticket failed: ${(err as Error).message}. Try again.` };
    }
    this.deps.store.lessons.settle(draft.id, 'filed', ['dispatched'], {
      fix: input.fix,
      title: input.title,
      summary: input.summary,
      reason: input.reason,
      ticketRef,
    });
    return { ok: true, outcome: 'ticket', ticketRef };
  }
}
