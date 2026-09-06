import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { WorldSnapshot } from './types.js';
import { renamablePrs } from './prRename.js';
import { retargetsFor } from './prRetarget.js';

// → docs/spec/07-pull-requests.md

interface PrNamingDeskDeps {
  sink: ActionSink;
  defaultBranch: string;
  prAuthorConfigured: boolean;
  template: string;
  errors?: ErrorRecorder;
}

export class PrNamingDesk {
  constructor(private readonly deps: PrNamingDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    await this.rename(world);
    await this.retarget(world);
  }

  private async retarget(world: WorldSnapshot): Promise<void> {
    const { sink, errors } = this.deps;
    const wanted = retargetsFor(world.pullRequests, world.closedPullRequests ?? [], this.deps.defaultBranch);
    for (const input of wanted) {
      try {
        await sink.setPullBase(input);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `retargeting PR ${input.prNumber} onto ${input.base} failed: ${(err as Error).message}`,
        });
      }
    }
  }

  private async rename(world: WorldSnapshot): Promise<void> {
    const { sink, errors } = this.deps;
    const wanted = renamablePrs(world.pullRequests, {
      prAuthorConfigured: this.deps.prAuthorConfigured,
      template: this.deps.template,
      issues: world.issues,
    });
    for (const input of wanted) {
      try {
        await sink.setPullTitle(input);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `renaming PR ${input.prNumber} failed: ${(err as Error).message}`,
        });
      }
    }
  }
}
