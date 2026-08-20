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
  url: '',
};
