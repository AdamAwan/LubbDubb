import { localRunIsLive } from '../store/localRuns.js';
import type { LocalRunner } from './runner.js';
import type { LocalRunWatch } from './watch.js';

/**
 * The environment as a session reads it.
 *
 * **`running` is presumed, not probed** — and it says so, because the one thing a
 * session must not do is report a check passed against a page it never saw. The
 * watch's readings ride along: the declared port answering is a reading, and a
 * different claim from the application working. The output tail comes too, for the
 * same reason it is in the panel: the case worth explaining is the start that did
 * not work.
 *
 * **One function, two channels.** The operator's own Claude reads this through
 * `local_run` on the desktop channel and a validating agent reads it through
 * `local_run_read` on the fleet's ([11](../../docs/spec/11-mcp-tools.md#the-desktop-channel)).
 * Two names, because the tools are not the same tool — the desktop one can *start*
 * the environment and the fleet's may only look at it — but one answer, because the
 * caveat is the whole point and a second copy of it is a second thing to get wrong.
 * That is the sharp edge `validation_report` already carries, arriving from the
 * other side: there, one behaviour behind two tools; here, one reading behind two.
 */
export function describeLocalRun(runner: LocalRunner, watch: LocalRunWatch): Record<string, unknown> {
  const run = runner.current();
  if (run === null)
    return {
      running: false,
      note: 'Nothing has been started locally on this machine.',
    };
  const running = localRunIsLive(run);
  const readings = watch.reading();
  return {
    // Through `localRunIsLive`, not a fifth hand-written copy of which statuses count
    // — and `stopping` is one of them, so a session asking during a teardown is told
    // the environment is still up rather than that it is free to start another.
    running,
    goal: run.originRef,
    ref: run.ref,
    commit: run.commit,
    dir: run.dir,
    status: run.status,
    turn: runner.turn(),
    holdsSession: runner.holdsSession(),
    url: run.url,
    startedAt: run.startedAt,
    note: run.note,
    ports: running ? readings.ports : null,
    freshness: running ? readings.freshness : null,
    // The port may be probed; the application is not. The status means the session
    // that was told to bring it up finished without failing, and `ports.declared.answering`
    // means something accepted a TCP connection — neither is the page working, and
    // reporting a check passed on the strength of either would be the one outcome the
    // whole validation channel exists to prevent.
    caveat:
      'The harness probes the port but does not exercise the application: `running` means the session that ' +
      'brought it up did not fail, and `ports.declared.answering` means something accepted a connection. ' +
      'Open the URL and see for yourself before you report anything about it.',
    output: runner.output().slice(-40),
  };
}
