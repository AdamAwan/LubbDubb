import type { ExtensionHost } from '../extensions/host.js';
import type { ExtensionSlots } from '../extensions/slots.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentHead, EnvironmentProber } from './prober.js';
import { atFromExtension, routeByEnvironment } from './readingExtensions.js';

// → docs/spec/24-environments.md#from-the-projects-extension

type ReadingHost = Pick<ExtensionHost<ExtensionSlots>, 'call'>;

/** The project's extension naming the commit an environment is at. Not answering is no head, never an empty one. */
export class ExtensionEnvironmentProber implements EnvironmentProber {
  constructor(private readonly host: ReadingHost) {}

  async at(environment: string): Promise<EnvironmentHead> {
    const answer = await this.host.call('deployedCommits', { environment });
    if (!answer.ok) return { commits: null, detail: answer.detail };
    return { commits: answer.value.commits, detail: null };
  }
}

/** The prober for each environment: the extension's where it sets `atExtension`, else the `at` command's. */
export class RoutedEnvironmentProber implements EnvironmentProber {
  private readonly for: (environment: string) => EnvironmentProber;

  constructor(environments: readonly EnvironmentConfig[], commands: EnvironmentProber, extension: EnvironmentProber) {
    this.for = routeByEnvironment(environments, atFromExtension, commands, extension);
  }

  at(environment: string, command: string): Promise<EnvironmentHead> {
    return this.for(environment).at(environment, command);
  }
}
