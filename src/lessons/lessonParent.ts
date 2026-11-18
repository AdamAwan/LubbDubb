import type { ErrorRecorder } from '../errorLog.js';
import type { WorkItemReading } from '../sink/actionSink.js';

// → docs/spec/41-repo-lessons.md#the-lessons-own-work-item

interface LessonParentDeps {
  /** `lessons.parentWorkItem`; null files no Task. */
  number: number | null;
  read: (number: number) => Promise<WorkItemReading | null>;
  watchLabel: string;
  errors?: ErrorRecorder;
}

/** The story every lesson's own Task is filed under, once read and found fit; a refusal or failed read is read again next time. */
export class LessonParent {
  private verdict: number | null | undefined;
  private inFlight: Promise<number | null> | null = null;

  constructor(private readonly deps: LessonParentDeps) {}

  /** The parent's number, or null when it is unset, refused, or could not be read this time. */
  resolve(): Promise<number | null> {
    if (this.verdict !== undefined) return Promise.resolve(this.verdict);
    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async check(): Promise<number | null> {
    const number = this.deps.number;
    if (number === null) return (this.verdict = null);
    let item: WorkItemReading | null;
    try {
      item = await this.deps.read(number);
    } catch (err) {
      this.deps.errors?.record({
        source: 'provider',
        message: `reading lessons.parentWorkItem #${number} failed: ${(err as Error).message}`,
      });
      return null;
    }
    const watch = this.deps.watchLabel.toLowerCase();
    const refusal =
      item === null
        ? `no work item #${number} exists`
        : item.labels.some((l) => l.toLowerCase() === watch)
          ? `#${number} carries the watch label "${this.deps.watchLabel}", so the fleet would dispatch for it`
          : null;
    if (refusal === null) return (this.verdict = number);
    this.deps.errors?.record({
      source: 'cycle',
      message: `lessons.parentWorkItem refused: ${refusal}. Lesson pull requests open with no work item until it is fixed.`,
    });
    return null;
  }
}
