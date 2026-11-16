import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { localValidationOutputDir } from '../validation/local/origin.js';
import { mediaKind } from '../validation/media.js';
import { validationGoalDir } from '../validation/resources.js';
import { DailySweep } from './dailySweep.js';

// → docs/spec/14-persistence.md#recording-retention

interface RecordingRetentionDeps {
  store: Store;
  validationRoot: string;
  retentionDays: number;
  errors: ErrorRecorder;
  now?: () => number;
}

/**
 * Validation videos are large, so they go a set number of days after the run that recorded them
 * ended. Screenshots and readings stay: only the video file and the name pointing at it are removed.
 */
export class RecordingRetentionDesk {
  private readonly window: DailySweep;

  constructor(private readonly deps: RecordingRetentionDeps) {
    this.window = new DailySweep(deps.retentionDays, deps.now);
  }

  run(): void {
    if (this.window.due()) this.sweep();
  }

  /** @returns how many videos were deleted. */
  sweep(): number {
    if (!this.window.enabled) return 0;
    const before = this.window.cutoff();
    try {
      return this.sweepRemote(before) + this.sweepLocal(before);
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `The recording retention sweep failed: ${(err as Error).message}`,
      });
      return 0;
    }
  }

  private sweepRemote(before: string): number {
    const { store, validationRoot } = this.deps;
    let deleted = 0;
    for (const run of store.remoteValidation.listRemoteRuns()) {
      if (run.recording === null || run.endedAt === null || run.endedAt >= before) continue;
      rmSync(join(validationGoalDir(validationRoot, run.goalRef), run.recording), { force: true });
      store.remoteValidation.clearRemoteRunRecording(run.id);
      deleted += 1;
    }
    return deleted;
  }

  private sweepLocal(before: string): number {
    const { store, validationRoot } = this.deps;
    let deleted = 0;
    for (const row of store.localValidations.listLocalValidationsEndedBefore(before)) {
      const videos = row.screenshots.filter(isVideo);
      if (videos.length === 0) continue;
      const dir = localValidationOutputDir(validationRoot, row.originRef, row.id);
      for (const name of videos) rmSync(join(dir, name), { force: true });
      store.localValidations.setLocalValidationMedia(
        row.id,
        row.screenshots.filter((name) => !isVideo(name)),
      );
      deleted += videos.length;
    }
    return deleted;
  }
}

function isVideo(name: string): boolean {
  return mediaKind(name) === 'video';
}
