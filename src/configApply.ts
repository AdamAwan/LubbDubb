import { CONFIG_FIELDS, readPath } from './configFields.js';
import type { Config } from './config.js';
import type { CiPolicy } from './ci/ciPolicy.js';
import type { RuntimeControl } from './runtimeControl.js';

/**
 * What a config change does to a *running* harness, and the only place that
 * question is answered.
 *
 * `loadConfig` runs once, at boot, and most of what it produces is copied into a
 * consumer's constructor — so the honest answer for most keys is "at the next
 * restart". It is not the answer for all of them, and the difference is not a
 * property of the key: it is whether something here re-seats whoever holds the
 * value. A key is **live because it has an arm below**, never because a table
 * says so. Add an arm and it becomes live; hoist a value into a const somewhere
 * and the arm stops compiling, which is the point.
 *
 * The arms mutate the running `Config` object as well as poking the consumer,
 * because the object *is* the late reader for anything read through a closure
 * (`system.ts`'s `knowledgeBlock`). That mirrors {@link RuntimeControl}, which the
 * cap and pause flag have always worked this way through.
 *
 * → `docs/spec/02-configuration.md#liveness`
 */
export interface ConfigChange {
  /** Dotted path into the config object. */
  path: string;
  from: unknown;
  to: unknown;
  /** Whether an arm below applied it, or it is waiting for a restart. */
  applied: boolean;
}

/** What a live arm needs to reach. Wired in `system.ts`, like everything else. */
interface LiveConfigDeps {
  /**
   * The config object the harness was built from — the one every late reader
   * closed over. An arm assigns onto *this*, never onto a copy.
   */
  running: Config;
  runtimeControl: RuntimeControl;
  /** The rule dispatcher, which took a copy of the CI policy at construction. */
  dispatcher: CiPolicyHolder;
}

/** The seam {@link RuleDispatcher.setCiPolicy} answers. */
interface CiPolicyHolder {
  setCiPolicy(ci: CiPolicy): void;
}

type LiveArm = (next: Config, deps: LiveConfigDeps) => void;

/**
 * The named arms, keyed by the field path each one makes live.
 *
 * Deliberately short. Every arm is a second place a value lives and so a place
 * two copies can disagree; a key nobody changes twice a year is better left
 * restart-only than made live for the sake of it. Seven earn it: the cap because
 * an operator changes it while watching the fleet, the lesson cap because it is
 * already read at every launch, the CI policy because it is the one rule set an
 * operator tunes against a red pull request in front of them, the state
 * colours because they are picked while looking at the chips they change, the
 * local run's instruction because it is corrected while a start is failing, the
 * scope-staleness window because it is a reading tuned against the page that
 * draws it, and the reply auto-send because the switch that matters is turning it
 * back **off**.
 */
const LIVE_ARMS: Readonly<Record<string, LiveArm>> = {
  // Already live by construction: `RuntimeControl` is read by reference each
  // cycle. Saving the configured value re-seats the live one — the live one stays
  // ephemeral, so a restart still comes back to whatever the file says.
  maxConcurrentAgents: (next, deps) => {
    deps.running.maxConcurrentAgents = next.maxConcurrentAgents;
    deps.runtimeControl.apply({ cap: next.maxConcurrentAgents });
  },
  // The executor asks the running config by reference at every act it authorizes
  // (`autoSendReplies` in `system.ts` is a thunk over this object), so assigning
  // onto it *is* the arm. Live because it is the one switch an operator flips
  // while watching a draft they did not want to be asked about — and, more
  // importantly, because it is the one they flip back: a restart-only off switch
  // would keep sending replies for as long as it took to bounce the harness.
  sendPrRepliesWithoutApproval: (next, deps) => {
    deps.running.sendPrRepliesWithoutApproval = next.sendPrRepliesWithoutApproval;
  },
  // `system.ts` renders the knowledge block through a closure at every agent
  // launch, reading `config.knowledgeBlockChars` each time — so assigning onto the
  // running object *is* the arm, and the next dispatch uses it.
  knowledgeBlockChars: (next, deps) => {
    deps.running.knowledgeBlockChars = next.knowledgeBlockChars;
  },
  // `buildStateSnapshot` reads the running config by reference at every poll and
  // takes the staleness verdict there, so assigning onto it *is* the arm — the
  // colours' arm and the colours' reason. Live because this is a reading an
  // operator tunes while looking at the page it changes: a key that silently
  // needed a restart would be a number they widened, watched do nothing, and
  // widened again.
  knowledgeScopeStaleDays: (next, deps) => {
    deps.running.knowledgeScopeStaleDays = next.knowledgeScopeStaleDays;
  },
  // `buildStateSnapshot` reads the running config by reference at every poll and
  // ships the colours to the cockpit, so assigning onto it *is* the arm: a colour
  // picked in the config page is on the chips a heartbeat later. Nothing in the
  // harness reads a colour, so there is no consumer to re-seat and no second copy
  // this could disagree with.
  issueStateColours: (next, deps) => {
    deps.running.issueStateColours = next.issueStateColours;
  },
  // The colours' arm, for the colours' reason: the snapshot reads the running config
  // by reference at every poll, so assigning onto it *is* the arm — a column
  // reordered on the config page is on the board a heartbeat later. Nothing in the
  // harness reads this either, so there is no consumer to re-seat.
  issueBoardStates: (next, deps) => {
    deps.running.issueBoardStates = next.issueBoardStates;
  },
  // The runner reads `config.localRun` by reference at every start, and the
  // snapshot reads it at every poll — so assigning the object onto the running
  // config *is* the arm. Live because this is the one field an operator edits
  // while a start has just failed in front of them: restart-only here would mean
  // bouncing the harness to correct a typo in a command, with the fleet's agents
  // going down with it. The whole reason it is a config key and not a prompt.
  'localRun.instruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.stopInstruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.url': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  // `PetKeeper` closed over `config.pets` at construction and reads
  // `policy.visible` on every `state()`, so the field is assigned onto the object
  // it holds — replacing `running.pets` wholesale would leave the keeper on the
  // old policy while the config page said the change had applied. Live because
  // this one is pure presentation: nothing it can reach hatches, feeds or clears.
  'pets.visible': (next, deps) => {
    deps.running.pets.visible = next.pets.visible;
  },
  // The dispatcher took `{checks: ci.checks ?? []}` at construction, so this one
  // has to hand it a new policy rather than assign and hope.
  'ci.checks': (next, deps) => {
    deps.running.ci = next.ci;
    deps.dispatcher.setCiPolicy(next.ci);
  },
};

/** Whether saving this field takes effect now. The form draws it; nothing asserts it. */
export function isLiveField(path: string): boolean {
  return Object.hasOwn(LIVE_ARMS, path);
}

/** Every field an arm makes live, for the test that keeps the classification honest. */
export function liveFieldPaths(): readonly string[] {
  return Object.keys(LIVE_ARMS);
}

/**
 * Which declared fields differ between two configs.
 *
 * Declared fields only: an unknown key a hand-edited file carries has no arm and
 * no widget, so it changes nothing that can be applied. It still reaches the
 * cockpit through the running config's "Other" group, which is where a typo is
 * meant to be visible.
 */
export function diffConfig(running: Config, next: Config): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const field of CONFIG_FIELDS) {
    const from = readPath(running, field.path);
    const to = readPath(next, field.path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ path: field.path, from, to, applied: isLiveField(field.path) });
  }
  return changes;
}

/**
 * The running harness's view of a config that has changed under it — whatever
 * changed it, a save from the cockpit or an editor on the operator's own machine.
 *
 * Both routes land here, which is the whole of "the creator still likes to edit
 * config.json": one apply path means a hand edit and a form save cannot produce
 * different outcomes.
 */
export class LiveConfig {
  private readonly deps: LiveConfigDeps;
  /** Changes that landed in the file and are waiting for a restart to take effect. */
  private pendingChanges: ConfigChange[] = [];

  constructor(deps: LiveConfigDeps) {
    this.deps = deps;
  }

  /**
   * Apply a reloaded config: live keys through their arms, everything else held
   * as pending. Returns every change it saw, applied or not.
   *
   * Pending is **recomputed** from the two configs rather than accumulated. Once
   * the arms have run, whatever still differs between what the harness is running
   * and what the file says *is* the definition of waiting for a restart — so
   * editing a key twice leaves one row rather than two, and putting one back to
   * what the harness is running leaves none. An accumulated list gets the second
   * of those wrong and keeps claiming a restart is owed for a change that has
   * been undone.
   */
  apply(next: Config): ConfigChange[] {
    const changes = diffConfig(this.deps.running, next);
    for (const change of changes) LIVE_ARMS[change.path]?.(next, this.deps);
    this.pendingChanges = diffConfig(this.deps.running, next);
    return changes;
  }

  /** What is waiting for a restart, for the cockpit to say so. */
  pending(): readonly ConfigChange[] {
    return this.pendingChanges;
  }
}
