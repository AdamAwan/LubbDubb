import type { Config } from '../config/config.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import { McpDesktopServer } from '../mcp/desktop.js';
import type { DesktopRemoteValidation } from '../mcp/desktopContext.js';
import type { Store } from '../store/store.js';
import type { RemoteIntentDesk } from '../validation/remote/intent.js';
import type { RemoteRunDesk } from '../validation/remote/run.js';
import { orderedProfiles } from '../agents/modelPolicy.js';
import { prRefStyle } from '../pr/prRef.js';
import { apiUrl } from '../server/apiUrl.js';
import { buildRemoteSheets } from '../server/stateEnvironmentViews.js';
import type { Foundation, LateBinding } from './systemFoundation.js';

// → docs/spec/11-mcp-tools.md#the-desktop-channel

export function buildDesktop(
  config: Config,
  { store, connector, sink, runtimeControl, errors, discussions, discussionPulls }: Foundation,
  prompts: PromptTemplates,
  late: LateBinding,
): McpDesktopServer {
  return new McpDesktopServer({
    store,
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    localRun: (): LocalRunner => late.get().localRun,
    localRunWatch: (): LocalRunWatch => late.get().localRunWatch,
    runtimeControl,
    harness: () => late.get().harness,
    escalations: () => late.get().escalations,
    permissions: () => late.get().permissions,
    recovery: () => late.get().recovery,
    ejections: () => late.get().ejections,
    agents: () => late.get().agents,
    filing: () => late.get().filing,
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    comments: sink,
    discussions,
    discussionPulls,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    agentModels: config.agentModels,
    asks: () => late.get().askSnapshot(),
    cockpitUrl: apiUrl(config),
    proposals: () => late.get().proposals,
    prAssign: () => late.get().prAssign,
    runCycle: () =>
      late
        .get()
        .harness.runCycle('manual')
        .then(() => undefined),
    remoteValidation: () => desktopRemoteValidation(config, store, late.get()),
    watchAsks: () => late.get().watchAsks,
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });
}

export function desktopRemoteValidation(
  config: Config,
  store: Store,
  { remoteRuns, remoteIntents }: { remoteRuns: RemoteRunDesk; remoteIntents: RemoteIntentDesk },
): DesktopRemoteValidation {
  return {
    sheets: (goalRef) =>
      buildRemoteSheets(
        store,
        config.environments,
        [],
        undefined,
        config.remoteValidation.tenants,
        store.validation.listAllValidationChecks(),
      ).filter((sheet) => sheet.goalRef === goalRef),
    give: (goalRef, environment) => remoteIntents.give(goalRef, environment),
    press: (goalRef, environment) => remoteRuns.press(goalRef, environment),
    cancel: (environment) => remoteRuns.cancel(environment, null),
    prepareTenant: (environment) => remoteRuns.beginPrepareTenant(environment),
  };
}
