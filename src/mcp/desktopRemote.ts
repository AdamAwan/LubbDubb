import { z } from 'zod';
import { issueOrigin } from '../plans/planning.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import type { RemoteSheetView } from '../wire.js';

// → docs/spec/11-mcp-tools.md#remote-validation-from-the-desktop

const remoteValidationRead: DesktopToolFactory = (deps) => ({
  description:
    "Read a goal's remote validation: for each deployed environment the harness validates it on, the sheet of " +
    "rows the harness runs against that environment's tenant, where the page stands (needs your OK, queued, " +
    'running, done), which tenant it is put to and how fresh it is, and the latest reading on every row. ' +
    'These checks are run by the harness — never on this machine. Records nothing.',
  inputSchema: toolSchema(z.object({ issue: z.number().describe('The goal number, e.g. 284.') })),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const validating = deps.environments.filter((e) => e.validate !== undefined).map((e) => e.name);
    if (validating.length === 0)
      return toolError(
        'No environment on this deployment declares a "validate" block, so there is no remote validation to ' +
          'read or run. Checks for this goal, if it has any, are the ones validation_read lists.',
      );
    const sheets = deps.remoteValidation().sheets(issueOrigin(ref.issue));
    const assembled = new Set(sheets.map((s) => s.environment));
    return toolJson({
      issue: ref.issue,
      sheets: sheets.map(describeSheet),
      noSheet: validating.filter((name) => !assembled.has(name)),
      next: READ_NEXT,
    });
  },
});

const READ_NEXT =
  "Run these through remote_validation_run — the harness spawns the project's own runner against the tenant. " +
  'Do not run a suite, a state query or a tenant command yourself: a reading taken here is one the sheet never ' +
  'sees, against a tenant the lock does not know is in use. "action": "ok" is the usual answer to a page that ' +
  'needs you. An environment under noSheet has had nothing assembled for this goal yet.';

function describeSheet(sheet: RemoteSheetView): Record<string, unknown> {
  return {
    environment: sheet.environment,
    standing: sheet.ok,
    wouldRun: sheet.okable,
    tenant: {
      name: sheet.tenant.tenant,
      reseededAt: sheet.tenant.reseededAt,
      stale: sheet.tenant.stale,
      blocked: sheet.tenant.blockedReason,
      preparable: sheet.tenant.reseedable,
      destructive: sheet.tenant.destructive,
      preparation: sheet.tenant.preparation,
    },
    run:
      sheet.run === null
        ? null
        : {
            id: sheet.run.id,
            status: sheet.run.status,
            startedAt: sheet.run.startedAt,
            endedAt: sheet.run.endedAt,
            note: sheet.run.note,
            artefacts: sheet.run.artefacts,
          },
    rows: sheet.rows.map((row) => ({
      rowId: row.rowId,
      kind: row.kind,
      title: row.title,
      selected: row.selected,
      blocked: row.blockedReason,
      awaitingApproval: row.awaitingApproval,
      idle: row.idleReason,
      reading:
        row.reading === null
          ? null
          : { outcome: row.reading.outcome, detail: row.reading.detail, artefacts: row.reading.artefacts },
    })),
  };
}

const ACTIONS = ['ok', 'press', 'cancel', 'prepare_tenant'] as const;

const remoteValidationRun: DesktopToolFactory = (deps) => ({
  description:
    "Have the harness run a goal's remote validation on a deployed environment — the same controls as the " +
    "sheet in the cockpit. The harness runs everything against the environment's tenant; nothing runs on this " +
    'machine. "ok" answers the page once: accepts the check set, approves its state queries and queues the ' +
    'run for the harness to press when the tenant is free. "press" runs the selected rows now. "cancel" ' +
    'calls off the live run. "prepare_tenant" runs the environment\'s own ensureTenant / reseed commands — ' +
    'where it reseeds, that wipes the tenant, so it needs confirmTenant.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      environment: z.string().describe('The environment, as remote_validation_read names it.'),
      action: z.enum(ACTIONS).describe('ok (the usual one), press, cancel or prepare_tenant.'),
      confirmTenant: z
        .string()
        .describe(
          'Only for prepare_tenant on an environment that reseeds: the tenant name remote_validation_read ' +
            "gave, typed back — a reseed destroys that tenant's data and nothing undoes it. Ask the operator " +
            'before you send it.',
        )
        .optional(),
    }),
  ),
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const environment = typeof args.environment === 'string' ? args.environment : '';
    if (environment === '') return toolError('environment is required — remote_validation_read names them.');
    const action = ACTIONS.find((a) => a === args.action);
    if (action === undefined) return toolError(`action must be one of ${ACTIONS.join(', ')}.`);
    const goalRef = issueOrigin(ref.issue);
    const confirm = typeof args.confirmTenant === 'string' ? args.confirmTenant : undefined;
    switch (action) {
      case 'ok':
        return give(deps, goalRef, environment);
      case 'press':
        return press(deps, goalRef, environment);
      case 'cancel':
        return cancel(deps, environment);
      case 'prepare_tenant':
        return prepareTenant(deps, goalRef, environment, confirm);
    }
  },
});

async function give(deps: DesktopToolDeps, goalRef: string, environment: string) {
  const given = await deps.remoteValidation().give(goalRef, environment);
  if (!given.ok) return toolError(given.error);
  deps.changed({ type: 'dirty', sections: ['goals'] });
  await deps.runCycle();
  return toolJson({
    given: given.intent.state,
    refused: given.refused,
    sheet: standingOf(deps, goalRef, environment),
    means: AFTER_RUN,
  });
}

async function press(deps: DesktopToolDeps, goalRef: string, environment: string) {
  const pressed = await deps.remoteValidation().press(goalRef, environment);
  if (!pressed.ok) return toolError(pressed.error);
  deps.changed({ type: 'dirty', sections: ['goals'] });
  await deps.runCycle();
  return toolJson({
    run: { id: pressed.run.id, status: pressed.run.status },
    abandoned: pressed.abandoned,
    read: pressed.read,
    owed: pressed.owed,
    means: AFTER_RUN,
  });
}

const AFTER_RUN =
  'The harness is running it. A run owed to an agent is dispatched by the fleet and takes minutes; read it ' +
  'again with remote_validation_read rather than waiting here, and report readings as the sheet gives them — ' +
  'a queued or running page is not a pass.';

function cancel(deps: DesktopToolDeps, environment: string) {
  const cancelled = deps.remoteValidation().cancel(environment);
  if (cancelled === null) return toolError(`no run is live on "${environment}" for this goal's tenant.`);
  deps.changed({ type: 'dirty', sections: ['goals'] });
  return toolJson({ cancelled: { id: cancelled.id, status: cancelled.status, note: cancelled.note } });
}

function prepareTenant(deps: DesktopToolDeps, goalRef: string, environment: string, confirm: string | undefined) {
  const env = deps.environments.find((e) => e.name === environment);
  if (env?.validate?.ensureTenant === undefined && env?.validate?.reseed === undefined)
    return toolError(`"${environment}" declares neither an "ensureTenant" nor a "reseed" command.`);
  if (env.validate.reseed !== undefined) {
    const sheet = deps
      .remoteValidation()
      .sheets(goalRef)
      .find((s) => s.environment === environment);
    const tenant = sheet?.tenant.tenant ?? environment;
    if (confirm !== tenant)
      return toolError(
        `"${environment}" reseeds: its own command wipes tenant "${tenant}" back to seeded fixture data, taking ` +
          'whatever anybody arranged there, and nothing undoes it. Ask the operator, then call again with ' +
          `confirmTenant "${tenant}".`,
      );
  }
  const begun = deps.remoteValidation().prepareTenant(environment);
  if (!begun.started) return toolError(begun.detail);
  deps.changed({ type: 'dirty', sections: ['goals', 'harness'] });
  return toolJson({
    started: true,
    detail: begun.detail,
    tenant: begun.standing,
    means:
      'The commands run for tens of minutes and keep going if this session ends. remote_validation_read ' +
      "shows the tenant's preparation; give the OK once it has finished.",
  });
}

function standingOf(deps: DesktopToolDeps, goalRef: string, environment: string): unknown {
  const sheet = deps
    .remoteValidation()
    .sheets(goalRef)
    .find((s) => s.environment === environment);
  return sheet === undefined ? null : sheet.ok;
}

export const DESKTOP_REMOTE_TOOLS = {
  remote_validation_read: remoteValidationRead,
  remote_validation_run: remoteValidationRun,
};
