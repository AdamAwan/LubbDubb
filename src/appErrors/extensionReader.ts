import type { ExtensionHost } from '../extensions/host.js';
import type { ExtensionSlots } from '../extensions/slots.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { errorsFromExtension, READING_SLOT_LABELS, routeByEnvironment } from '../environments/readingExtensions.js';
import {
  capDetailOutput,
  type AppErrorDetailOutput,
  type AppErrorDetailRequest,
  type AppErrorDetailRunner,
} from './detailCommand.js';
import type { AppErrorReader, AppErrorReadRequest } from './reader.js';
import { readAppErrorReport, unreadableErrors, type AppErrorReport } from './report.js';

// → docs/spec/39-app-errors.md#from-the-projects-extension

type ReadingHost = Pick<ExtensionHost<ExtensionSlots>, 'provider' | 'call'>;

/** The project's extension listing the error groups. Its answer is read by the command's own contract. */
export class ExtensionAppErrorReader implements AppErrorReader {
  constructor(private readonly host: ReadingHost) {}

  async list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    const answer = await this.host.call('appErrors', { environment: request.environment, since: request.since });
    if (!answer.ok) return unreadableErrors(answer.detail);
    return readAppErrorReport(answer.value);
  }
}

/** The error reader for each environment: the extension's where it sets `errors.extension`, else `errors.list`'s. */
export class RoutedAppErrorReader implements AppErrorReader {
  private readonly for: (environment: string) => AppErrorReader;

  constructor(environments: readonly EnvironmentConfig[], commands: AppErrorReader, extension: AppErrorReader) {
    this.for = routeByEnvironment(environments, errorsFromExtension, commands, extension);
  }

  list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    return this.for(request.environment).list(request);
  }
}

/** The project's extension answering the detail on one group. */
export class ExtensionAppErrorDetailRunner implements AppErrorDetailRunner {
  constructor(private readonly host: ReadingHost) {}

  async detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput> {
    const answer = await this.host.call('appErrorDetail', {
      environment: request.environment,
      fingerprint: request.fingerprint,
      since: request.since,
    });
    if (!answer.ok) return { ok: false, failure: answer.detail };
    return capDetailOutput(answer.value.text);
  }
}

/**
 * The detail query for each environment, and whether there is one: `errors.detail` where commands
 * answer, the `appErrorDetail` slot where the extension does and fills it. What runs and what the
 * triage brief says is declared are both read here.
 */
export class RoutedAppErrorDetail implements AppErrorDetailRunner {
  private readonly for: (environment: string) => AppErrorDetailRunner;
  private readonly commands: ReadonlyMap<string, string | null>;

  constructor(
    environments: readonly EnvironmentConfig[],
    host: Pick<ExtensionHost<ExtensionSlots>, 'provider'>,
    commands: AppErrorDetailRunner,
    extension: AppErrorDetailRunner,
  ) {
    this.for = routeByEnvironment(environments, errorsFromExtension, commands, extension);
    const slot = host.provider('appErrorDetail') === null ? null : READING_SLOT_LABELS.errorsDetail;
    this.commands = new Map(
      environments.map((e) => [e.name, errorsFromExtension(e) ? slot : (e.errors?.detail ?? null)]),
    );
  }

  /** What `errors.detail` names on this environment, or what answers in its place; null where nothing does. */
  command(environment: string): string | null {
    return this.commands.get(environment) ?? null;
  }

  detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput> {
    return this.for(request.environment).detail(request);
  }
}
