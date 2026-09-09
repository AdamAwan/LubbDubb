import {
  parseSelectorListing,
  type RemoteRunner,
  type RunnerOutcome,
  type RunnerRequest,
  type SelectorListing,
} from './runner.js';

// → docs/spec/36-remote-validation.md#seams-and-why-the-fake-comes-first

/** What the fake was asked for, so a test asserts on a record rather than on an absence. */
interface RunnerAsk {
  call: 'listSelectors' | 'run' | 'publishArtefacts';
  environment: string;
  command: string;
  profile: string | null;
  tenant: string | null;
  selectors: readonly string[];
  reportDir: string | null;
}

interface Script {
  /** What `listSelectors` prints, parsed exactly as the command implementation parses it. */
  listing?: string;
  /** Where a listing could not answer at all: a non-zero exit, a kill, or nothing printed. */
  listingFailure?: string;
  run?: RunnerOutcome;
  artefacts?: RunnerOutcome;
}

/**
 * Every project-supplied command in this design is a live shell command against a real environment,
 * and `runner` drives a browser through one. A test that configures a `validate.browser` block and
 * injects no `remoteRunner` runs the project's own suite against somebody's acceptance environment
 * and passes while doing it — the `FakeUpstreamIssues` failure exactly.
 */
export class FakeRemoteRunner implements RemoteRunner {
  readonly asked: RunnerAsk[] = [];

  constructor(private readonly scripted: Record<string, Script> = {}) {}

  listSelectors(request: RunnerRequest): Promise<SelectorListing> {
    const script = this.answer('listSelectors', request);
    if (script?.listingFailure !== undefined) return Promise.resolve({ offers: null, detail: script.listingFailure });
    if (script?.listing === undefined)
      return Promise.resolve({ offers: null, detail: 'nothing scripted this listing.' });
    return Promise.resolve(parseSelectorListing(script.listing));
  }

  run(request: RunnerRequest): Promise<RunnerOutcome> {
    return Promise.resolve(this.answer('run', request)?.run ?? { said: null, detail: 'nothing scripted this run.' });
  }

  publishArtefacts(request: RunnerRequest): Promise<RunnerOutcome> {
    return Promise.resolve(
      this.answer('publishArtefacts', request)?.artefacts ?? { said: null, detail: 'nothing scripted this publish.' },
    );
  }

  private answer(call: RunnerAsk['call'], request: RunnerRequest): Script | undefined {
    const { environment, command, profile, tenant, selectors, reportDir } = request;
    this.asked.push({ call, environment, command, profile, tenant, selectors: [...selectors], reportDir });
    return this.scripted[environment];
  }
}
