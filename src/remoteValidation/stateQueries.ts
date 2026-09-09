import type { Store } from '../store/store.js';
import type {
  StateQuery,
  StateQueryApproval,
  StateQueryAuthor,
  StateQueryInput,
  WatchReadingVerdict,
} from '../types.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { WatchResult } from '../environments/watchResult.js';
import { stateExecutor, stateExecutors } from './enabled.js';
import type { StateQueryKind, StateReader } from './stateReader.js';

// → docs/spec/36-remote-validation.md

interface StateReading {
  environment: string;
  verdict: WatchReadingVerdict;
  presence: WatchReadingVerdict | null;
  rows: number | null;
  detail: string | null;
  sample: string | null;
  /** Non-null means no reading was taken at all — what a sheet renders `blocked`, never `failed`. */
  blocked: string | null;
}

interface StateQueryDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  reader: StateReader;
}

const SAMPLE_ROWS = 5;

export class StateQueryDesk {
  constructor(private readonly deps: StateQueryDeps) {}

  /** @public the seam `state_declare`, the routes and the prompt note all read */
  configured(): boolean {
    return stateExecutors(this.deps.environments).length > 0;
  }

  /** @public the seam `state_declare` and the operator's own writer both declare through */
  async declare(
    originRef: string,
    queries: readonly StateQueryInput[],
    authored: StateQueryAuthor,
  ): Promise<{ declared: string[]; refusals: string[] }> {
    const declared = this.deps.store.saveStateQueries(originRef, queries, authored);
    return { declared, refusals: await this.dryRun(originRef, declared) };
  }

  /**
   * Put each named query to an environment that can answer it and keep what it said beside the query.
   * That reading is the whole of the evidence an operator accepts or rejects on: a query that reads
   * correctly and returns nonsense is caught here, and only here.
   *
   * @public the seam the routes and `state_declare` reach the dry run through
   */
  async dryRun(originRef: string, only?: readonly string[]): Promise<string[]> {
    const environment = stateExecutor(this.deps.environments);
    if (environment === null) return [];
    return this.putTo(environment, originRef, only);
  }

  /** @public the seam the approval route reads a query against one named environment through */
  async read(environment: EnvironmentConfig, query: StateQuery): Promise<StateReading> {
    const command = environment.validate!.state!.run;
    const probe = await this.ask(environment, command, query, 'presence');
    const presence = verdictOf(probe);
    if (presence === 'unknown')
      return {
        environment: environment.name,
        verdict: 'unknown',
        presence,
        rows: null,
        detail: `the store on ${environment.name} could not be read — ${probe.detail ?? 'the query did not answer'}`,
        sample: null,
        blocked: `${environment.name} did not answer: ${probe.detail ?? 'the query did not answer'}`,
      };
    if (presence === 'zero')
      return {
        environment: environment.name,
        verdict: 'unknown',
        presence,
        rows: null,
        detail:
          `the presence query matched nothing on ${environment.name}, so this store has never held the ` +
          'thing being asked about — wrong table, wrong tenant, wrong name, or nothing written yet. A ' +
          'state query cannot read clean while its presence query is silent.',
        sample: null,
        blocked: `the presence query matched nothing on ${environment.name}, so nothing was learned about the goal`,
      };
    const result = await this.ask(environment, command, query, 'state');
    const verdict = verdictOf(result);
    if (verdict === 'unknown')
      return {
        environment: environment.name,
        verdict,
        presence,
        rows: null,
        detail: `the store on ${environment.name} could not be read — ${result.detail ?? 'the query did not answer'}`,
        sample: null,
        blocked: `${environment.name} did not answer: ${result.detail ?? 'the query did not answer'}`,
      };
    return {
      environment: environment.name,
      verdict,
      presence,
      rows: result.rows!.length,
      detail: null,
      sample: JSON.stringify(result.rows!.slice(0, SAMPLE_ROWS)),
      blocked: null,
    };
  }

  /** @public the seam the approval route writes an operator's consent through */
  async rule(
    originRef: string,
    queryId: string,
    environmentName: string,
    accept: boolean,
  ): Promise<{ query: StateQuery; reading: StateReading | null; approval: StateQueryApproval | null } | null> {
    const query = this.deps.store.listStateQueries().find((q) => q.originRef === originRef && q.id === queryId);
    if (query === undefined) return null;
    const environment = stateExecutor(this.deps.environments, environmentName);
    if (environment === null) return null;
    if (!accept) {
      this.deps.store.declineStateQuery(query.digest, environment.name);
      return { query, reading: null, approval: null };
    }
    const reading = await this.read(environment, query);
    this.deps.store.recordStateQueryDryRun(originRef, queryId, reading);
    if (reading.blocked !== null) return { query, reading, approval: null };
    this.deps.store.approveStateQuery({
      digest: query.digest,
      environment: environment.name,
      originRef,
      queryId,
      rows: reading.rows,
      detail: reading.detail,
    });
    const approval =
      this.deps.store
        .listStateQueryApprovals()
        .find((a) => a.digest === query.digest && a.environment === environment.name) ?? null;
    return { query, reading, approval };
  }

  private async putTo(environment: EnvironmentConfig, originRef: string, only?: readonly string[]): Promise<string[]> {
    const refusals: string[] = [];
    for (const query of this.deps.store.listStateQueries()) {
      if (query.originRef !== originRef) continue;
      if (only !== undefined && !only.includes(query.id)) continue;
      const reading = await this.read(environment, query);
      this.deps.store.recordStateQueryDryRun(originRef, query.id, reading);
      if (reading.detail !== null) refusals.push(`${query.id}: ${reading.detail}`);
    }
    return refusals;
  }

  private ask(
    environment: EnvironmentConfig,
    command: string,
    query: StateQuery,
    kind: StateQueryKind,
  ): Promise<WatchResult> {
    return this.deps.reader.read({
      environment: environment.name,
      command,
      queryId: query.id,
      query: kind === 'presence' ? query.presence : query.query,
      kind,
    });
  }
}

function verdictOf(result: WatchResult): WatchReadingVerdict {
  if (result.verdict === 'unknown' || result.rows === null) return 'unknown';
  return result.rows.length === 0 ? 'zero' : 'fires';
}
