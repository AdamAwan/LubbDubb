// → docs/spec/43-handled-for-you.md

export type HandledKind = 'placement' | 'profile';

export type HandledState = 'open' | 'checked' | 'undone';

export interface HandledAction {
  id: number;
  kind: HandledKind;
  issueNumber: number;
  before: string | null;
  after: string;
  reason: string;
  state: HandledState;
  createdAt: string;
}
