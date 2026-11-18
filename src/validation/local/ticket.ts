import type { ErrorRecorder } from '../../errorLog.js';
import { issueOriginNumber } from '../../issueOrigins.js';
import type { PromptTemplates } from '../../dispatcher/promptTemplates.js';
import type { Store } from '../../store/store.js';
import type { TicketFiler } from '../../tickets/filing.js';
import type { LocalValidation } from '../../types.js';
import { findingItem } from './briefing.js';

// → docs/spec/32-local-validation.md#when-it-fails

const MAX_TITLE_CHARS = 200;

const RETRY_AFTER_MS = 30 * 60 * 1000;

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
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly deps: LocalValidationTicketDeps) {}

  async run(): Promise<void> {
    if (!this.deps.canFile()) return;
    const { localValidations } = this.deps.store;
    for (const row of localValidations.listLocalValidationsAwaitingTicket(this.deps.defaultBranch)) {
      if (Date.now() - (this.failedAt.get(row.id) ?? 0) < RETRY_AFTER_MS) continue;
      if (!localValidations.claimLocalValidationTicket(row.id)) continue;
      const number = issueOriginNumber('root', row.originRef);
      if (number === null) continue;
      try {
        const title = this.titleOf(number);
        const ref = await this.deps.filing({
          title: `Local validation failed: #${String(number)}${title === null ? '' : ` ${title}`}`.slice(
            0,
            MAX_TITLE_CHARS,
          ),
          body: this.deps.prompts.render('local-validation-ticket-body', vars(row, number, title ?? 'untitled')),
          bug: true,
          labels: [this.deps.watchLabel],
          relatedTo: number,
          searchKey: `local-validation:${row.id}`,
        });
        localValidations.settleLocalValidationTicket(row.id, ref);
        this.failedAt.delete(row.id);
        this.deps.changed();
      } catch (err) {
        localValidations.settleLocalValidationTicket(row.id, null);
        this.failedAt.set(row.id, Date.now());
        this.deps.errors.record({
          source: 'cycle',
          message: `Could not file the bug for a failed local validation of ${row.originRef}: ${(err as Error).message}`,
        });
      }
    }
  }

  private titleOf(number: number): string | null {
    const issue = this.deps.store.world.getWorldBaseline()?.issues.find((i) => i.number === number);
    return issue?.title ?? null;
  }
}

function vars(row: LocalValidation, number: number, title: string): Record<string, string> {
  return {
    number: String(number),
    title,
    summary: row.summary ?? '',
    commit: row.commit ?? row.ref,
    findings: row.findings.map(findingItem).join('\n\n'),
  };
}
