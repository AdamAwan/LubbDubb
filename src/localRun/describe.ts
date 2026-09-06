import { localRunIsLive } from '../store/localRuns.js';
import type { LocalRunner } from './runner.js';
import type { LocalRunWatch } from './watch.js';

// → docs/spec/23-local-runs.md

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
    caveat:
      'The harness probes the port but does not exercise the application: `running` means the session that ' +
      'brought it up did not fail, and `ports.declared.answering` means something accepted a connection. ' +
      'Open the URL and see for yourself before you report anything about it.',
    output: runner.output().slice(-40),
  };
}
