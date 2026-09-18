import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { HumanTask } from '../types.js';

// → docs/spec/06-issue-pickup.md#a-watched-feature-reports-the-children-nothing-can-see

type UnwatchedFindingStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

export interface UnwatchedFeature {
  number: number;
  originRef: string;
  title: string;
  /** Its open children carrying no watch tag. */
  unwatched: number[];
  /** How many open children it has in total, tagged or not — the denominator the row quotes. */
  open: number;
  /** Of `unwatched`, the ones an accepted order has another story waiting behind. */
  holding: number[];
}

/**
 * The row's title, and the key `recordHumanTask` dedups on.
 *
 * It carries the Feature's number and **not its count**, because the count is the one thing about
 * this row that moves: fold it into the title and every story tagged files a second row beside the
 * first, with the stale one settling for nobody. The count lives in the detail, which is rewritten
 * on every pulse.
 */
function unwatchedTitle(feature: number): string {
  return `Feature #${feature} has stories the fleet cannot see`;
}

export function unwatchedChildFindings(input: {
  features: readonly UnwatchedFeature[];
  existing: readonly HumanTask[];
}): UnwatchedFindingStep[] {
  const byOrigin = new Map(input.existing.map((t) => [`${t.originRef ?? ''} ${t.title}`, t]));
  const steps: UnwatchedFindingStep[] = [];
  const owed = new Set<string>();

  for (const feature of input.features) {
    const title = unwatchedTitle(feature.number);
    const key = `${feature.originRef} ${title}`;
    const existing = byOrigin.get(key);
    if (feature.unwatched.length === 0) {
      if (existing?.status === 'open') {
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: DESK_SETTLED + 'every story under this Feature now carries the watch tag',
        });
      }
      continue;
    }
    owed.add(key);
    const detail = unwatchedDetail(feature);
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing)) steps.push({ kind: 'reopen', taskId: existing.id, detail });
      continue;
    }
    steps.push({ kind: 'file', originRef: feature.originRef, title, detail });
  }

  // A Feature that has dropped out of the watched set entirely — un-watched, closed, or emptied of
  // children — is not a standing obligation. The row goes, and says which of those it cannot tell
  // apart rather than claiming the operator tagged anything.
  for (const task of input.existing) {
    if (task.status !== 'open') continue;
    const key = `${task.originRef ?? ''} ${task.title}`;
    if (owed.has(key)) continue;
    if (input.features.some((f) => `${f.originRef} ${unwatchedTitle(f.number)}` === key)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'done',
      resolution: DESK_SETTLED + 'the harness no longer reads this Feature as watched work',
    });
  }

  return steps;
}

function unwatchedDetail(feature: UnwatchedFeature): string {
  const list = (numbers: readonly number[]): string => numbers.map((n) => `#${n}`).join(', ');
  const one = feature.unwatched.length === 1;
  const lines = [
    `You are watching **${feature.title}** (#${feature.number}), and ${one ? 'one' : feature.unwatched.length} of ` +
      `its ${feature.open} open stories ${one ? 'carries' : 'carry'} no watch tag: ${list(feature.unwatched)}. ` +
      `${one ? 'It is' : 'They are'} not behind and not in the queue — no agent has read ` +
      `${one ? 'it' : 'them'}, and none will.`,
    '',
    'Watching a container cascades the tag onto everything under it at the moment you press it, and only then. A ' +
      'story added to this Feature afterwards, or tagged off by hand, is outside that write — which is what this ' +
      'row is reporting, and why it is a reading rather than a fix.',
  ];

  if (feature.holding.length > 0) {
    const holdOne = feature.holding.length === 1;
    lines.push(
      '',
      `**${list(feature.holding)} ${holdOne ? 'is' : 'are'} holding other work.** The accepted order for this ` +
        `Feature has ${holdOne ? 'a story' : 'stories'} waiting behind ${holdOne ? 'it' : 'them'}, and a ` +
        `predecessor nothing will work is a wait that does not end. Tag ${holdOne ? 'it' : 'them'} to release the ` +
        'stories behind, or amend the order.',
    );
  }

  lines.push(
    '',
    'Press **Watch** on the Feature to cascade the tag over all of it again. **Done** says you have looked and ' +
      `${one ? 'that story is' : 'those stories are'} deliberately out of scope; the harness re-files this row ` +
      'only if the Feature gains another story it cannot see.',
  );
  return lines.join('\n');
}
