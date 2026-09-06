// → docs/spec/23-local-runs.md

export interface LocalRunPolicy {
  instruction: string;
  stopInstruction: string;
  resumeInstruction: string;
  resumeWindowMs: number;
  refreshInstruction: string;
  url: string;
}

export const DEFAULT_LOCAL_RUN: LocalRunPolicy = {
  instruction: '',
  stopInstruction: '',
  resumeInstruction: '',
  resumeWindowMs: 2 * 60 * 60 * 1000,
  refreshInstruction: '',
  url: '',
};
