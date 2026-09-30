// → docs/spec/37-bot-prs.md#configuration

export interface BotPrPolicy {
  authors: string[];
}

export const DEFAULT_BOT_PRS: BotPrPolicy = {
  authors: [],
};
