import { parseAppErrorReport, unreadableErrors, type AppErrorReport } from './report.js';
import type { AppErrorReadRequest, AppErrorReader } from './reader.js';
import {
  capDetailOutput,
  type AppErrorDetailOutput,
  type AppErrorDetailRequest,
  type AppErrorDetailRunner,
} from './detailCommand.js';

// → docs/spec/39-app-errors.md

export class FakeAppErrorReader implements AppErrorReader {
  readonly asked: AppErrorReadRequest[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  script(environment: string, stdout: string): void {
    this.output[environment] = stdout;
  }

  list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    this.asked.push(request);
    const stdout = this.output[request.environment];
    if (stdout === undefined) return Promise.resolve(unreadableErrors('unscripted'));
    return Promise.resolve(parseAppErrorReport(stdout));
  }
}

/** Answers the detail query from scripted output per environment, and records every request. Never spawns. */
export class FakeAppErrorDetailRunner implements AppErrorDetailRunner {
  readonly asked: AppErrorDetailRequest[] = [];

  constructor(private readonly output: Record<string, AppErrorDetailOutput | string> = {}) {}

  script(environment: string, output: AppErrorDetailOutput | string): void {
    this.output[environment] = output;
  }

  detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput> {
    this.asked.push(request);
    const out = this.output[request.environment];
    if (out === undefined) return Promise.resolve({ ok: false, failure: 'unscripted' });
    return Promise.resolve(typeof out === 'string' ? capDetailOutput(out) : out);
  }
}
