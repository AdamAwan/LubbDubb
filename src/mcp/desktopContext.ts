import type { AgentManager } from '../agents/agentManager.js';
import type { AgentModels } from '../agents/modelPolicy.js';
import type { PermissionDesk } from '../agents/permissionDesk.js';
import type { RecoveryDesk } from '../agents/recoveryDesk.js';
import type { EjectionDesk } from '../ejection/desk.js';
import type { Config } from '../config/config.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import type { PrRefStyle } from '../pr/prRef.js';
import type { ProposalDesk } from '../proposals/proposalDesk.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { IssueWatchContext } from '../issueWatch.js';
import type { SendResult, WorkItemAreaPathInput, WorkItemParentInput } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { UpcomingPlan } from '../wire.js';
import type { McpTool } from './protocol.js';

// → docs/spec/11-mcp-tools.md

export interface DesktopToolDeps {
  store: Store;
  claimMinutes: number;
  validationRoot: string;
  environments: EnvironmentConfig[];
  prRefStyle?: PrRefStyle;
  localRun(): LocalRunner;
  localRunWatch(): LocalRunWatch;
  proposals(): ProposalDesk;
  runCycle(): Promise<void>;

  runtimeControl: RuntimeControl;
  harness(): { upcoming: UpcomingPlan | null };
  escalations(): EscalationInbox;
  agents(): AgentManager;
  filing(): TicketFiler;
  briefConfig(): Config;
  renderTicketBody(vars: Record<string, string>): string;
  profileNames(): string[];
  permissions(): PermissionDesk;
  recovery(): RecoveryDesk;
  ejections(): EjectionDesk;
  connector: IssueWatchContext['sink'] & {
    canPlaceWorkItem(): boolean;
    setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
    setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
  };
  errors?: ErrorRecorder;
  labelPrefix: string;
  issueContainerTypes: string[];
  agentModels: AgentModels | undefined;
  now(): string;
}

export interface DesktopSession {
  label: string;
  held: { originRef: string; checkId: string; claimedAt: string | null } | null;
}

export type DesktopToolFactory = (deps: DesktopToolDeps, session: DesktopSession) => Omit<McpTool, 'name'>;
