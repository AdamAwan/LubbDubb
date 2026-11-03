import type { ErrorRecorder } from '../errorLog.js';
import type { DiscussionDocument, TrackerComment, WorldSnapshot } from '../types.js';
import { DISCUSSION_AUTHORS, type DiscussionFiles } from './discussionFile.js';

// → docs/spec/40-discussions.md#pulling-tracker-comments-in

const PULL_INTERVAL_MS = 5 * 60_000;

interface IssueCommentReader {
  canListIssueComments(): boolean;
  listIssueComments(number: number, since: string | null): Promise<TrackerComment[]>;
}

interface DiscussionPullDeskDeps {
  discussions: Pick<DiscussionFiles, 'enabled' | 'numbers' | 'read' | 'add' | 'setFrontMatter'>;
  comments: IssueCommentReader;
  /** The ids of every issue comment the harness itself posted on this issue. */
  sent(issueNumber: number): ReadonlySet<string>;
  errors: ErrorRecorder;
  nowMs?: () => number;
}

export type DiscussionPull =
  { ok: true; added: number; skipped: number; pulled: string | null } | { ok: false; error: string };

export class DiscussionPullDesk {
  private readonly lastPulledAt = new Map<number, number>();
  private readonly inFlight = new Map<number, Promise<DiscussionPull>>();
  private readonly nowMs: () => number;

  constructor(private readonly deps: DiscussionPullDeskDeps) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  async run(world: WorldSnapshot): Promise<void> {
    if (!this.deps.discussions.enabled || !this.deps.comments.canListIssueComments()) return;
    let numbers: number[];
    try {
      numbers = this.deps.discussions.numbers();
    } catch (error) {
      this.deps.errors.record({
        source: 'cycle',
        message: 'The discussions folder could not be listed; no tracker comments were pulled.',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const tracked = new Set(world.issues.map((i) => i.number));
    const due = this.nowMs() - PULL_INTERVAL_MS;
    for (const number of numbers) {
      if (!tracked.has(number) || (this.lastPulledAt.get(number) ?? -Infinity) > due) continue;
      await this.pull(number);
    }
  }

  pull(number: number): Promise<DiscussionPull> {
    const running = this.inFlight.get(number);
    if (running !== undefined) return running;
    const next = this.pullOnce(number).finally(() => this.inFlight.delete(number));
    this.inFlight.set(number, next);
    return next;
  }

  private async pullOnce(number: number): Promise<DiscussionPull> {
    if (!this.deps.discussions.enabled) return { ok: false, error: 'Discussions are off: discussionsDir is not set.' };
    if (!this.deps.comments.canListIssueComments())
      return { ok: false, error: 'No issues provider here can list comments, so there is nothing to pull.' };
    const doc = this.deps.discussions.read(number);
    if (doc === null) return { ok: false, error: `There is no discussion file for #${number}.` };
    this.lastPulledAt.set(number, this.nowMs());

    let comments: TrackerComment[];
    try {
      comments = await this.deps.comments.listIssueComments(number, doc.frontMatter.pulled);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.errors.record({
        source: 'cycle',
        message: `Could not read the tracker comments on #${number} for its discussion file.`,
        detail,
      });
      return { ok: false, error: `Could not read the tracker comments on #${number}: ${detail}` };
    }
    return this.fold(doc, number, comments);
  }

  private fold(doc: DiscussionDocument, number: number, comments: TrackerComment[]): DiscussionPull {
    const ours = new Set(this.deps.sent(number));
    if (doc.frontMatter.published) ours.add(doc.frontMatter.published);
    const subject = { number, title: doc.frontMatter.title ?? `#${number}`, kind: doc.frontMatter.kind ?? 'story' };
    const ordered = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let pulled = doc.frontMatter.pulled;
    let added = 0;
    let failure: string | null = null;
    for (const comment of ordered) {
      if (!ours.has(comment.id)) {
        const author = DISCUSSION_AUTHORS.tracker(comment.author);
        const write = this.deps.discussions.add(subject, { kind: 'note', body: comment.body, author });
        if (!write.ok) {
          failure = write.error;
          break;
        }
        added += 1;
      }
      if (pulled === null || Date.parse(comment.createdAt) > Date.parse(pulled)) pulled = comment.createdAt;
    }
    if (pulled !== null && pulled !== doc.frontMatter.pulled) {
      const marked = this.deps.discussions.setFrontMatter(number, { pulled });
      if (!marked.ok) failure ??= marked.error;
    }
    const skipped = ordered.filter((c) => ours.has(c.id)).length;
    return failure === null ? { ok: true, added, skipped, pulled } : { ok: false, error: failure };
  }
}
