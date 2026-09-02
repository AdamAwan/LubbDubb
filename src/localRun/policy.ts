/**
 * The local run's operator policy: how this deployment's application is brought
 * up on the operator's own machine, and where it is reachable once it is.
 *
 * Its own module for {@link DEFAULT_VALIDATION}'s reason — the policy's default
 * belongs beside the subsystem that means it rather than in the middle of
 * `config.ts`.
 *
 * **Config rather than a prompt template**, which is where this started. How a
 * project starts is the operator's opinion, and the prompt book is where this repo
 * keeps the operator's opinions — but prompt overrides are a file drop that takes
 * effect at the next restart, and are read-only in the cockpit *on purpose*
 * (`src/server/routes/state.ts`: a write route "would have to answer 'when does
 * this take effect', and the honest answer — at the next restart — is worse than
 * not offering it"). An instruction an operator edits while trying to get their
 * environment up is exactly the thing that must not need a restart, so it is a
 * live config field instead. → `docs/spec/02-configuration.md`
 */
export interface LocalRunPolicy {
  /**
   * What the session bringing the environment up is told, verbatim.
   *
   * Free text rather than a command, because the machine that can start this
   * deployment is the one with the operator's own tooling on it: `/dev-environment
   * start` is a Claude Code command and not a shell one, and a project whose start
   * is three steps and a wait has nowhere to say so in a single command string.
   *
   * **Empty means the feature is off**, and says so where it would otherwise be
   * offered: nothing is drawn as startable, because a harness that spawned a
   * session with no instruction would be paying for a session to guess.
   */
  instruction: string;
  /**
   * What the session taking the environment **down** is told, verbatim.
   *
   * A second field rather than a signal, because a dev environment is not a process
   * tree. Killing the session's subtree is right and takes the session and its own
   * children with it — and it cannot touch a Docker container, which belongs to the
   * daemon, or anything else a start handed off to a service. Nothing the harness
   * can send stops those, which is why a project that can be started at all tends
   * to have a dedicated command for stopping.
   *
   * **Empty means a stop kills the session and no more**, and the panel says so
   * rather than implying it took the environment with it. Blank is a supported
   * state, not a broken one: plenty of projects are a single process, where the
   * reap is the whole story.
   */
  stopInstruction: string;
  /**
   * What a session is told to bring an **interrupted** run back, verbatim.
   *
   * A third field rather than a re-run of {@link instruction}, because the two are
   * not the same job. A start is handed a machine with nothing of this project up
   * on it; a resume is handed one where the last session was reaped mid-flight — the
   * containers it left are very likely still running, the ports are very likely
   * still held, and the honest thing to do with them is to attach rather than to
   * bring up a second stack beside them. Only the project knows which of its pieces
   * survive a reap, so that is the operator's sentence to write too.
   *
   * **Empty means an interrupted run settles the way it always did**, with the note
   * saying that nothing was configured to bring it back. Blank is a supported state:
   * a deployment that would rather click Start itself is a deployment that spends
   * nothing on a boot nobody was watching.
   */
  resumeInstruction: string;
  /**
   * How long after the interruption a run may still be brought back.
   *
   * A resume was built for a restart — an Apply on the Config page, a Ctrl-C, an
   * upgrade handoff — where the operator is a minute away from wanting their
   * environment back and the containers the reap could not touch are still up. None
   * of that is true of a harness that was off overnight: the machine has very likely
   * been rebooted, nothing of the run survives to attach to, and what the boot
   * actually does is spend a session on an environment nobody asked for and nobody
   * is watching.
   *
   * Two hours, which is long enough to cover a restart an operator walked away from
   * and short enough that yesterday's run is not brought back this morning. `0`
   * means no bound, which is the old behaviour exactly — a supported setting for a
   * deployment whose environment really does survive anything.
   *
   * Judged on the run's `interruptedAt`, so a run whose interruption was never
   * stamped is out of the window whatever this says.
   */
  resumeWindowMs: number;
  /**
   * Where the application lands, once it is up — drawn as a link in the panel.
   *
   * Declared rather than detected. Reading it out of the log would mean matching a
   * URL in output whose shape is every framework's own, and being wrong there is a
   * link that goes nowhere beside a run that is working perfectly.
   */
  url: string;
}

export const DEFAULT_LOCAL_RUN: LocalRunPolicy = {
  instruction: '',
  stopInstruction: '',
  resumeInstruction: '',
  resumeWindowMs: 2 * 60 * 60 * 1000,
  url: '',
};
