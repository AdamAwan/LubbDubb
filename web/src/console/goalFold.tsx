import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, GoalSection } from '../view/goalPage.js';
import { goalSectionsOpen, GOAL_SECTIONS } from '../view/goalPage.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

export interface Fold {
  open: boolean;
  /**
   * Whether `open` is the operator's own answer rather than the page's default. A
   * card whose reading only it holds — the criteria, the prediction — narrows the
   * default it was handed, and must not narrow a fold somebody opened on purpose.
   * → docs/spec/17-cockpit.md#folding-what-is-not-relevant-yet
   */
  settled: boolean;
  onToggle: (open: boolean) => void;
  reveal: () => void;
}

export function buildFolds(page: GoalPageView, view: CockpitView, actions: CockpitActions): Record<GoalSection, Fold> {
  const byDefault = goalSectionsOpen(page);
  const entries = GOAL_SECTIONS.map((section): [GoalSection, Fold] => {
    const settled = view.goalOpen.has(section) || view.goalShut.has(section);
    const open = view.goalOpen.has(section) ? true : view.goalShut.has(section) ? false : byDefault[section];
    return [
      section,
      {
        open,
        settled,
        onToggle: (next) => {
          if (next) logUsage('goal.expand');
          actions.openGoalSection(section, next);
        },
        reveal: () => {
          if (!open) actions.openGoalSection(section, true);
        },
      },
    ];
  });
  return Object.fromEntries(entries) as Record<GoalSection, Fold>;
}

export function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button type="button" className="cn-disc" aria-expanded={open} onClick={() => onToggle(!open)}>
      <i className="cn-caret">{open ? '▾' : '▸'}</i>
      {label}
    </button>
  );
}
