import type { EnvironmentGate, RemoteRowKind } from '../types.js';
import { QUERY_URL_TOKENS } from './watchQueryUrl.js';

// → docs/spec/24-environments.md

export interface EnvironmentConfig {
  name: string;
  at: string;
  health?: string;
  arrival?: EnvironmentArrival;
  watch?: EnvironmentWatch;
  validate?: EnvironmentValidate;
}

const REMOTE_ROW_KINDS: readonly RemoteRowKind[] = ['check', 'state', 'signal', 'measure'];

interface EnvironmentValidate {
  permits: RemoteRowKind[];
  tenant?: string;
  tenantEnv?: string;
  ensureTenant?: string;
  reseed?: string;
  tenantFreshnessMs?: number;
  browser?: EnvironmentValidateBrowser;
  state?: { run: string };
}

interface EnvironmentValidateBrowser {
  runner: string;
  listSelectors?: string;
  profile?: string;
  publishArtefacts?: string;
}

interface EnvironmentWatch {
  observe: string;
  schema?: string;
  describe?: string;
  forMs?: number;
  holds?: EnvironmentGate[];
  queryUrl?: string;
}

const ENVIRONMENT_GATES: readonly EnvironmentGate[] = ['validate', 'close_out'];

interface EnvironmentArrival {
  opens?: EnvironmentGate[];
  comment?: boolean;
  workItemState?: string;
}

export function validateEnvironments(environments: EnvironmentConfig[]): void {
  if (!Array.isArray(environments))
    throw new Error('environments: must be a list of {name, at} entries — one per environment to probe.');
  const seen = new Set<string>();
  environments.forEach((env, i) => {
    const where = `environments[${i}]`;
    if (typeof env.name !== 'string' || env.name.trim() === '')
      throw new Error(`${where}: "name" must be a non-empty name — it is the key every reading is stored against.`);
    if (seen.has(env.name))
      throw new Error(
        `${where}: "${env.name}" is declared twice. Readings are keyed on the name, so the second command would ` +
          "overwrite the first's answers rather than adding an environment.",
      );
    seen.add(env.name);
    if ('command' in env)
      throw new Error(
        `${where} ("${env.name}"): "command" is no longer read. An environment now names the commit it is *at* — ` +
          'replace it with "at", a command printing the deployed commit, and the harness answers every landing from it.',
      );
    if (typeof env.at !== 'string' || env.at.trim() === '')
      throw new Error(
        `${where} ("${env.name}"): "at" must be a non-empty command printing the commit this environment is at. ` +
          'An empty one names nothing, which leaves every goal unanswered forever.',
      );
    if (env.health !== undefined && (typeof env.health !== 'string' || env.health.trim() === ''))
      throw new Error(
        `${where} ("${env.name}"): "health" must be a non-empty command printing a {"state": …} report, ` +
          'or be left out — with none, this environment is observed for reach and draws no health row.',
      );
    validateArrival(env.arrival, `${where} ("${env.name}")`);
    validateWatch(env, `${where} ("${env.name}")`);
    validateValidate(env.validate, `${where} ("${env.name}")`);
  });
}

function validateArrival(arrival: EnvironmentArrival | undefined, where: string): void {
  if (arrival === undefined) return;
  if (typeof arrival !== 'object' || arrival === null || Array.isArray(arrival))
    throw new Error(`${where}: "arrival" must be an object — {"opens": [...], "comment": true}.`);
  if (arrival.comment !== undefined && typeof arrival.comment !== 'boolean')
    throw new Error(`${where}: "arrival.comment" must be true or false.`);
  if (
    arrival.workItemState !== undefined &&
    (typeof arrival.workItemState !== 'string' || arrival.workItemState.trim() === '')
  )
    throw new Error(
      `${where}: "arrival.workItemState" must be a non-empty tracker state — the column a work item moves to ` +
        'when its goal arrives here — or be left out.',
    );
  if (arrival.opens !== undefined) {
    if (!Array.isArray(arrival.opens))
      throw new Error(`${where}: "arrival.opens" must be a list of ${ENVIRONMENT_GATES.join(' / ')}.`);
    if (arrival.opens.length === 0)
      throw new Error(
        `${where}: "arrival.opens" is empty. It reads as a gate and opens nothing — drop it, or name ` +
          `${ENVIRONMENT_GATES.join(' / ')}.`,
      );
    for (const gate of arrival.opens)
      if (!ENVIRONMENT_GATES.includes(gate))
        throw new Error(
          `${where}: "${String(gate)}" is not an obligation the harness files. ` +
            `"arrival.opens" names ${ENVIRONMENT_GATES.join(' / ')}.`,
        );
  }
  if (arrival.opens === undefined && arrival.comment !== true && arrival.workItemState === undefined)
    throw new Error(
      `${where}: "arrival" declares nothing. Name what arriving here opens, set "comment": true, or name the ` +
        '"workItemState" a work item moves to — or drop it, and the environment is observed and nothing more.',
    );
}

function validateWatch(env: EnvironmentConfig, where: string): void {
  const watch = env.watch;
  if (watch === undefined) {
    if ('describe' in env)
      throw new Error(
        `${where}: "describe" belongs inside "watch", beside the "observe" command it describes the schema for.`,
      );
    return;
  }
  if (typeof watch !== 'object' || watch === null || Array.isArray(watch))
    throw new Error(`${where}: "watch" must be an object — {"observe": "...", "schema": "..."}.`);
  if (typeof watch.observe !== 'string' || watch.observe.trim() === '')
    throw new Error(
      `${where}: "watch.observe" must be a non-empty command that answers a declared query. ` +
        'An empty one leaves every check on this environment unanswerable forever.',
    );
  if (watch.describe !== undefined && (typeof watch.describe !== 'string' || watch.describe.trim() === ''))
    throw new Error(`${where}: "watch.describe" must be a non-empty command, or be left out.`);
  if (
    watch.forMs !== undefined &&
    (typeof watch.forMs !== 'number' || !Number.isFinite(watch.forMs) || watch.forMs <= 0)
  )
    throw new Error(
      `${where}: "watch.forMs" must be a positive number of milliseconds — how long a window stays open.`,
    );
  validateWatchQueryUrl(watch.queryUrl, where);
  if (watch.holds === undefined) return;
  if (!Array.isArray(watch.holds))
    throw new Error(`${where}: "watch.holds" must be a list of ${ENVIRONMENT_GATES.join(' / ')}.`);
  for (const gate of watch.holds)
    if (!ENVIRONMENT_GATES.includes(gate))
      throw new Error(
        `${where}: "${String(gate)}" is not an obligation the harness files, so holding it holds nothing. ` +
          `"watch.holds" names ${ENVIRONMENT_GATES.join(' / ')}.`,
      );
}

function validateWatchQueryUrl(queryUrl: string | undefined, where: string): void {
  if (queryUrl === undefined) return;
  if (typeof queryUrl !== 'string' || queryUrl.trim() === '')
    throw new Error(`${where}: "watch.queryUrl" must be a non-empty URL template, or be left out.`);
  if (!QUERY_URL_TOKENS.some((token) => queryUrl.includes(token)))
    throw new Error(
      `${where}: "watch.queryUrl" carries none of ${QUERY_URL_TOKENS.join(' / ')}, so every check would link to ` +
        'the same page with nothing of its own query in it.',
    );
}

const TENANT_SHAPES = ['tenant', 'tenantEnv', 'ensureTenant'] as const;

function commandFields(validate: EnvironmentValidate): { path: string; value: unknown }[] {
  return [
    { path: 'ensureTenant', value: validate.ensureTenant },
    { path: 'reseed', value: validate.reseed },
    { path: 'browser.runner', value: validate.browser?.runner },
    { path: 'browser.listSelectors', value: validate.browser?.listSelectors },
    { path: 'browser.profile', value: validate.browser?.profile },
    { path: 'browser.publishArtefacts', value: validate.browser?.publishArtefacts },
    { path: 'state.run', value: validate.state?.run },
  ];
}

function validateValidate(validate: EnvironmentValidate | undefined, where: string): void {
  if (validate === undefined) return;
  if (typeof validate !== 'object' || validate === null || Array.isArray(validate))
    throw new Error(`${where}: "validate" must be an object — {"permits": ["state"], "state": {"run": "..."}}.`);

  if (!Array.isArray(validate.permits))
    throw new Error(
      `${where}: "validate.permits" must be a list of ${REMOTE_ROW_KINDS.join(' / ')} — the row kinds this ` +
        'environment may be asked for.',
    );
  if (validate.permits.length === 0)
    throw new Error(
      `${where}: "validate.permits" is empty. It reads as a configuration and permits nothing, so every row ` +
        `would come back blocked forever — name ${REMOTE_ROW_KINDS.join(' / ')}, or drop the "validate" block.`,
    );
  for (const kind of validate.permits)
    if (!REMOTE_ROW_KINDS.includes(kind))
      throw new Error(
        `${where}: "${String(kind)}" is not a row kind a sheet has. ` +
          `"validate.permits" names ${REMOTE_ROW_KINDS.join(' / ')}.`,
      );

  for (const path of ['tenant', 'tenantEnv'] as const) {
    const value = validate[path];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === ''))
      throw new Error(
        `${where}: "validate.${path}" must be a non-empty name, or be left out. The harness never generates ` +
          'or infers a tenant identifier, so an empty one names nothing it could fall back to.',
      );
  }

  for (const { path, value } of commandFields(validate))
    if (value !== undefined && (typeof value !== 'string' || value.trim() === ''))
      throw new Error(
        `${where}: "validate.${path}" must be a non-empty command, or be left out. An empty one answers ` +
          'nothing, and the row it would have run is blocked with no way to say why.',
      );

  if (validate.permits.includes('check') && validate.browser === undefined)
    throw new Error(
      `${where}: "validate.permits" names "check" and there is no "validate.browser" block. A kind permitted ` +
        'with nothing able to run it is every row of that kind blocked, forever — declare the runner, or drop ' +
        '"check" from "permits".',
    );
  if (validate.permits.includes('state') && (validate.state === undefined || typeof validate.state.run !== 'string'))
    throw new Error(
      `${where}: "validate.permits" names "state" and there is no "validate.state.run" command. A kind ` +
        'permitted with nothing able to run it is every row of that kind blocked, forever — declare the ' +
        'command, or drop "state" from "permits".',
    );
  if (validate.browser !== undefined && validate.browser.listSelectors === undefined)
    throw new Error(
      `${where}: "validate.browser" declares a runner and no "listSelectors". The pre-flight asks the ` +
        'deployed runner which selectors it offers, and without it every selector is unverifiable until a ' +
        'press has already been spent on it.',
    );

  const shapes = TENANT_SHAPES.filter((shape) => validate[shape] !== undefined);
  if (shapes.length > 1)
    throw new Error(
      `${where}: "validate" declares ${shapes.map((s) => `"${s}"`).join(' and ')} — two answers to one ` +
        'question. A tenant is a literal "tenant", a "tenantEnv" naming the variable that carries one, or an ' +
        '"ensureTenant" command that provisions one. Name exactly one.',
    );
  if (shapes.length === 0) {
    if (validate.reseed !== undefined)
      throw new Error(
        `${where}: "validate.reseed" reseeds a tenant and no tenant of any shape is declared. Name a ` +
          '"tenant", a "tenantEnv" or an "ensureTenant" — or drop the reseed.',
      );
    if (validate.tenantFreshnessMs !== undefined)
      throw new Error(
        `${where}: "validate.tenantFreshnessMs" is freshness about nothing — no tenant of any shape is ` +
          'declared here. Name a "tenant", a "tenantEnv" or an "ensureTenant", or drop it.',
      );
  }
  if (
    validate.tenantFreshnessMs !== undefined &&
    (typeof validate.tenantFreshnessMs !== 'number' ||
      !Number.isFinite(validate.tenantFreshnessMs) ||
      validate.tenantFreshnessMs <= 0)
  )
    throw new Error(
      `${where}: "validate.tenantFreshnessMs" must be a positive number of milliseconds — how old a tenant ` +
        'may be before a reading against it is drawn as stale.',
    );
}
