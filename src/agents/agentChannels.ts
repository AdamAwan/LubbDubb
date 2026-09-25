import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Store } from '../store/store.js';
import type { Agent, Task } from '../types.js';
import { extraMcpGrants, isSealedRule } from '../mcp/names.js';
import type { AgentSession } from './session.js';
import { classifyArtifact, type FileEventRecord } from './fileEvents.js';
import { PLAN_FILE, isPlanFile, parsePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { debugEnabled, debugLog } from '../debug.js';
import type { AgentEmitter, AgentManagerOptions } from './agentContract.js';

// → docs/spec/10-agent-runtimes.md

export class AgentChannels {
  private readonly eventsKeys = new Map<string, string>();
  private readonly mcpTokens = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
    private readonly events: AgentEmitter,
  ) {}

  bind(agentId: string, eventsKey: string | null, mcp: { token: string } | null): void {
    if (eventsKey) this.eventsKeys.set(agentId, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agentId);
      this.mcpTokens.set(agentId, mcp.token);
    }
  }

  openSession(
    task: Task,
    cwd: string,
    sessionId: string | null,
    resume: boolean,
  ): { session: AgentSession; eventsKey: string | null; mcp: { token: string; configPath: string | null } | null } {
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    const extraServers = task.mcpServers ?? [];
    const mcp = this.opts.mcp?.open(extraServers) ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        extraAllowedTools: extraMcpGrants(extraServers),
        resume,
        mcpConfigPath: mcp?.configPath ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
        permissionMode: task.permissionMode ?? null,
        sealed: isSealedRule(task.rule),
      }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId,
      resume,
    });
    return { session, eventsKey, mcp };
  }

  private eventsDirEnv(key: string | null): Record<string, string> {
    if (!key || !this.opts.fileEvents) return {};
    const env: Record<string, string> = { LUBBDUBB_EVENTS_DIR: this.opts.fileEvents.dirFor(key) };
    if (debugEnabled()) env.LUBBDUBB_EVENTS_DEBUG = '1';
    return env;
  }

  fileEventsDir(agentId: string): string | null {
    const key = this.eventsKeys.get(agentId);
    return key && this.opts.fileEvents ? this.opts.fileEvents.dirFor(key) : null;
  }

  drainFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    const records = this.opts.fileEvents.drain(key);
    if (records.length === 0) return;
    const agent = this.store.agents.getAgent(agentId);
    if (!agent) return;
    debugLog('fileEvents', `agent=${agentId} drained ${records.length} record(s)`);
    for (const rec of records) this.ingestFileEvent(agent, rec);
  }

  private ingestFileEvent(agent: Agent, rec: FileEventRecord): void {
    const path = toWorktreeRelative(agent.cwd, rec.path);
    const { promoted, kind } = classifyArtifact(path, this.opts.docsFolderPrefix);
    debugLog(
      'fileEvents',
      `agent=${agent.id} write path=${path} tool=${rec.tool ?? '?'} promoted=${promoted} kind=${kind}`,
    );
    this.store.agents.recordFile(agent.id, { path, tool: rec.tool, promoted });
    this.events.emit('files', { agentId: agent.id, taskId: agent.taskId });
    if (isPlanFile(path)) this.ingestPlan(agent, path);
    if (promoted) {
      const flag = this.store.agents.recordFlag(agent.id, { kind, label: basename(path), ref: path });
      this.events.emit('flag', { agentId: agent.id, taskId: agent.taskId, flag });
    }
  }

  private ingestPlan(agent: Agent, relPath: string): void {
    const task = this.store.tasks.getTask(agent.taskId);
    const number = planOriginIssue(task?.originRef ?? null);
    if (!task || number === null) {
      debugLog('fileEvents', `agent=${agent.id} wrote ${PLAN_FILE} but is not a planning agent — ignored`);
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(join(agent.cwd, relPath), 'utf8');
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} flagged ${PLAN_FILE} for issue #${number} but it could not be read: ${(err as Error).message}`,
      });
      return;
    }
    const parsed = parsePlanDocument(raw);
    if (!parsed.ok) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} wrote an invalid ${PLAN_FILE} for issue #${number}: ${parsed.error}`,
      });
      return;
    }
    const doc = parsed.document;
    const origin = issueOrigin(number);
    const result = ingestPlanDocument(this.store, {
      doc,
      originRef: origin,
      title: task.originTitle ?? task.title,
    });
    debugLog(
      'fileEvents',
      `agent=${agent.id} plan ingested issue=#${number} parts=${doc.parts.length} status=${result.status} ` +
        `retired=${result.retired.length}`,
    );
    void this.opts.watch?.run(origin).then(
      (refusals) => {
        if (refusals.length === 0) return;
        this.opts.errors?.record({
          source: 'agent',
          message:
            `Agent ${agent.id} declared a watch on issue #${number} whose queries did not resolve: ` +
            refusals.join('; '),
        });
      },
      (err: unknown) => {
        this.opts.errors?.record({
          source: 'agent',
          message: `The watch dry run for issue #${number} failed: ${(err as Error).message}`,
        });
      },
    );
  }

  disposeFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    this.drainFileEvents(agentId);
    if (debugEnabled()) {
      const crumbs = this.opts.fileEvents.readDebug(key);
      debugLog('fileEvents', `agent=${agentId} hook fired ${crumbs.length} time(s)`);
      for (const c of crumbs) debugLog('fileEvents', `agent=${agentId} hook: ${c}`);
    }
    this.opts.fileEvents.dispose(key);
    this.eventsKeys.delete(agentId);
  }

  releaseMcp(agentId: string): void {
    const token = this.mcpTokens.get(agentId);
    if (!token) return;
    this.mcpTokens.delete(agentId);
    this.opts.mcp?.release(token);
  }
}

function toWorktreeRelative(cwd: string, p: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, '/');
  if (!isAbsolute(p)) return toPosix(p);
  const rel = relative(cwd, p);
  return toPosix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p);
}
