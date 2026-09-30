// → docs/spec/37-bot-prs.md#configuration

export interface BotPrPolicy {
  authors: string[];
  /** A cron expression; empty turns the scheduled risk summary off and leaves only the button. */
  riskSchedule: string;
}

export const DEFAULT_BOT_PRS: BotPrPolicy = {
  authors: [],
  riskSchedule: '',
};
