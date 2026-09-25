import type { MutableRefObject, ReactNode } from 'react';
import type {
  GoalWatch,
  CaveatAnswerInput,
  IssueSpend,
  PlanAtom,
  PlanCaveat,
  PlanCaveatAnswer,
  Plan,
  PlanPartView,
  PlanningPolicy,
  Proposal,
  QueueItem,
  StateQuery,
  ValidationCheckView,
  ValidationPlanRecord,
} from '../types.js';
import type { useAcknowledgements } from './CaveatChecklist.js';

export interface PlanModalProps {
  plan: Plan;
  parts: PlanPartView[];
  atoms: PlanAtom[];
  checks: ValidationCheckView[];
  validationPlan: ValidationPlanRecord | null;
  caveatAnswers: PlanCaveatAnswer[];
  watches: GoalWatch[];
  queries: StateQuery[];
  upcoming: QueueItem[];
  proposal?: Proposal;
  spend: IssueSpend | null;
  planning: PlanningPolicy;
  now: number;
  refUrls: Record<string, string>;
  onClose: () => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onWatchProposal: (issueNumber: number, checkId: string, accept: boolean) => Promise<unknown> | unknown;
  onDecide: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
  ) => Promise<unknown> | unknown;
  onBackOut: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  onOpenGoal: (issueRef: string) => void;
  onPartProfile: (planId: string, slug: string, profile: string | null) => Promise<unknown> | unknown;
  onRestartPart: (planId: string, slug: string) => Promise<unknown> | unknown;
  regrouping?: boolean;
  onRegroupView?: (on: boolean) => void;
  onRegroup?: (
    planId: string,
    groups: { slug: string; atoms: string[]; title?: string; scope?: string }[],
  ) => Promise<unknown> | unknown;
  canClosePr: boolean;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
  desktopFolder: string;
}

export type SheetView = 'plan' | 'history';

export type Sections = MutableRefObject<Record<string, HTMLElement | null>>;
type Acknowledgements = ReturnType<typeof useAcknowledgements>;

/** What the modal derives once and every part of the sheet reads. */
export interface Derived {
  live: PlanPartView[];
  queued: Map<string, QueueItem>;
  originOf: (slug: string) => string;
  issueNumber: number | null;
  decidable: Proposal | null;
  caveats: PlanCaveat[];
  ack: Acknowledgements;
  sections: Sections;
}

export function JumpSection({
  at,
  sections,
  className,
  children,
}: {
  at: string;
  sections: Sections;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      ref={(el) => {
        sections.current[at] = el;
      }}
      className={className}
    >
      {children}
    </section>
  );
}
