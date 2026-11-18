import type { ErrorRecorder } from '../../errorLog.js';
import { issueOriginNumber } from '../../issueOrigins.js';
import type { PromptTemplates } from '../../dispatcher/promptTemplates.js';
import type { Store } from '../../store/store.js';
import type { TicketFiler } from '../../tickets/filing.js';
import type { LocalValidation } from '../../types.js';

// → docs/spec/32-local-validation.md#when-it-fails

const MAX_TITLE_CHARS = 200;

interface LocalValidationTicketDeps {
  store: Store;
  filing: TicketFiler;
  canFile: () => boolean;
  prompts: Pick<PromptTemplates, 'render'>;
  watchLabel: string;
  defaultBranch: string;
  errors: ErrorRecorder;
  changed: () => void;
}

export class LocalValidationTicketDesk {
  constructor(private readonly deps: LocalValidationTicketDeps) {}

  async run(): Promise<void> {
    if (!this.deps.canFile()) return;
    for (const row of this.deps.store.localValidations.listLocalValidationsAwaitingTicket(this.deps.defaultBranch)) {
      const number = issueOriginNumber('root', row.originRef);
      if (number === null) continue;
      try {
        const title = this.titleOf(number);
        const ref = await this.deps.filing({
          title: `Local validation failed: #${String(number)} ${title}`.slice(0, MAX_TITLE_CHARS),
          body: this.deps.prompts.render('local-validation-ticket-body', vars(row, number, title)),
          bug: true,
          labels: [this.deps.watchLabel],
          relatedTo: number,
        });
        this.deps.store.localValidations.markLocalValidationTicket(row.id, ref);
        this.deps.changed();
      } catch (err) {
        this.deps.errors.record({
          source: 'cycle',
          message: `Could not file the bug for a failed local validation of ${row.originRef}: ${(err as Error).message}`,
        });
      }
    }
  }

  private titleOf(number: number): string {
    const issue = this.deps.store.world.getWorldBaseline()?.issues.find((i) => i.number === number);
    return issue?.title ?? '';
  }
}

function vars(row: LocalValidation, number: number, title: string): Record<string, string> {
  return {
    number: String(number),
    title,
    summary: row.summary ?? '',
    commit: row.commit ?? row.ref,
    findings: row.findings
      .map((f, i) => `${String(i + 1)}. **${f.severity}: ${f.title}**\n\n   ${f.detail.replace(/\n/g, '\n   ')}`)
      .join('\n\n'),
  };
}
