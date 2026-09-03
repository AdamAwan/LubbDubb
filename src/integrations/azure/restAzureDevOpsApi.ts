import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod } from '../../sink/actionSink.js';
import { withinClosedWindow } from '../closedWindow.js';
import type { AreaPathTree } from '../../intake/placement.js';
import type {
  AzClosedPull,
  AzCommentRef,
  AzMergeResult,
  AzPolicyEvaluation,
  AzPolicyRequeue,
  AzPull,
  AzThread,
  AzTimelineRecord,
  AzWorkItem,
  AzWorkItemCommentRef,
  AzWorkItemUpdate,
  AzureDevOpsApi,
} from './azureDevOpsApi.js';
import { mergeStrategyFor, stripRef } from './sourceControl.js';
import { AzureEtagCache } from './conditionalRequests.js';

const execFileAsync = promisify(execFile);

/** The Azure DevOps resource GUID the `az` CLI mints access tokens against. */
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const API_VERSION = '7.1';

/** connectionData is a preview-only resource: 7.1 is rejected without the -preview suffix. */
const CONNECTION_DATA_API_VERSION = '7.1-preview.1';

/** The policy evaluations resource is preview-only under 7.1. */
const POLICY_API_VERSION = '7.1-preview.1';

/** Azure deletes a ref by updating it to this — there is no delete verb for one. */
const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

/** Work-item comments are preview-only under 7.1 (7.1 flat is rejected). */
const WORK_ITEM_COMMENTS_API_VERSION = '7.1-preview.4';

/**
 * How the harness authenticates to Azure DevOps. Two implementations ship, chosen
 * by {@link resolveAzureAuth}: a Personal Access Token (Basic auth) or, when no PAT
 * is set, an access token from the logged-in `az` CLI (Bearer). Injectable so the
 * REST client stays testable and the `az` spawn is isolated.
 */
export interface AzureAuth {
  /** The `Authorization` header value to send with each request. */
  header(): Promise<string>;
  /**
   * Drop any cached credential so the next {@link header} re-mints one. Called by the
   * request retry when Azure serves a sign-in page — an `az`-CLI token can need a beat
   * to propagate after a refresh, so a fresh token often clears a transient rejection.
   * A no-op for stateless auth (a PAT is fixed), hence optional.
   */
  forceRefresh?(): void;
}

/** Basic auth with a Personal Access Token — the empty username is the ADO convention. */
class PatAuth implements AzureAuth {
  constructor(private readonly pat: string) {}
  async header(): Promise<string> {
    return `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`;
  }
}

/**
 * Bearer auth from the logged-in `az` CLI (`az account get-access-token`). The
 * token is cached and refreshed on a fixed window rather than parsing Azure's
 * ambiguous local-time `expiresOn` — ADO tokens live well past this, so a
 * conservative refresh is safe and avoids a fragile date parse.
 */
class AzCliAuth implements AzureAuth {
  private cached: { token: string; fetchedAtMs: number } | null = null;
  /** Refresh well inside the token's real lifetime (typically 60–90 min). */
  private static readonly TTL_MS = 45 * 60 * 1000;

  constructor(private readonly fetchToken: () => Promise<string> = azCliAccessToken) {}

  async header(): Promise<string> {
    const now = Date.now();
    if (!this.cached || now - this.cached.fetchedAtMs >= AzCliAuth.TTL_MS) {
      this.cached = { token: await this.fetchToken(), fetchedAtMs: now };
    }
    return `Bearer ${this.cached.token}`;
  }

  /** Discard the cached token so the next {@link header} re-fetches from the `az` CLI. */
  forceRefresh(): void {
    this.cached = null;
  }
}

/**
 * Spawn the `az` CLI for an Azure DevOps access token. Throws a clear error if `az` isn't logged in.
 *
 * Exported so Setup's credential probe asks the *same* question the auth path asks
 * (`src/setup/probes.ts`). A second spawn written to look equivalent is how the
 * panel came to report a PAT as the only way in while the fleet ran happily on the
 * CLI. @public called by `RealSetupProbes.azSignedIn`.
 */
export async function azCliAccessToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'],
      // On Windows `az` is `az.cmd`; execFile won't resolve the extension without a
      // shell, so it ENOENTs. All args here are hardcoded constants — no injection risk.
      { shell: true },
    );
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    throw new Error(
      `Could not get an Azure DevOps token from the az CLI (${(err as Error).message}). ` +
        'Run `az login`, or set AZURE_DEVOPS_PAT to a Personal Access Token.',
    );
  }
}

/**
 * Pick the auth strategy: a Personal Access Token (`AZURE_DEVOPS_PAT`) if set,
 * otherwise the logged-in `az` CLI. The PAT is read from the environment only —
 * never from config — so a secret never lands in a committed file (mirroring
 * `GITHUB_TOKEN`).
 */
export function resolveAzureAuth(): AzureAuth {
  const pat = process.env.AZURE_DEVOPS_PAT;
  return pat ? new PatAuth(pat) : new AzCliAuth();
}

// ---------------------------------------------------------------------------
// Minimal shapes of the Azure DevOps JSON we read. Only the fields we consume.
// ---------------------------------------------------------------------------

interface RawPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId?: string };
  createdBy?: { uniqueName?: string; displayName?: string };
  reviewers?: Array<{ vote?: number; uniqueName?: string; isRequired?: boolean; isContainer?: boolean }>;
}

interface RawClosedPull {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  /** active | completed | abandoned. */
  status?: string;
  /** ISO instant the PR was completed or abandoned. Absent while still active. */
  closedDate?: string;
  createdBy?: { uniqueName?: string };
  lastMergeCommit?: { commitId?: string };
}

interface RawThread {
  id: number;
  status?: string | null;
  /** Where the thread hangs in the diff. Absent on a thread attached to no file. */
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
  comments?: Array<{
    id: number;
    author?: { uniqueName?: string };
    content?: string;
    parentCommentId?: number | null;
    commentType?: string;
  }>;
}

interface RawWorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
}

/**
 * How deep {@link RestAzureDevOpsApi.listAreaPaths} asks for. Azure's parameter
 * has no "everything", and an area tree past this depth is one nobody navigates.
 */
const AREA_DEPTH = 6;

interface RawClassificationNode {
  name?: string;
  path?: string;
  children?: RawClassificationNode[];
}

/**
 * A classification node's address in the form `System.AreaPath` accepts.
 *
 * Azure returns `\Contoso\Area\Web` and the field takes `Contoso\Web`: the
 * `\Area` infix names the *tree*, not a node, and writing it back is rejected.
 * Dropping it here is what keeps "the strings offered" and "the strings writable"
 * one set — two readings of one path is the drift worth avoiding, since an
 * unwritable candidate looks exactly like a writable one until the patch fails.
 */
function areaNodePath(node: RawClassificationNode): string | null {
  const raw = typeof node.path === 'string' && node.path !== '' ? node.path : null;
  if (raw === null) return null;
  const parts = raw.split('\\').filter((p) => p !== '');
  if (parts.length === 0) return null;
  return [parts[0], ...parts.slice(1).filter((p) => p !== 'Area')].join('\\');
}

interface RawWorkItemUpdate {
  revisedBy?: { uniqueName?: string };
  /** Per-revision field diffs; only System.Tags is read (its old/new are strings). */
  fields?: Record<string, { oldValue?: string; newValue?: string }>;
}

/** The timeline fields we read; Azure's record carries far more. */
interface RawTimelineRecord {
  type?: string;
  name?: string;
  result?: string | null;
  log?: { id?: number } | null;
  issues?: Array<{ type?: string; message?: string }>;
}

interface RawPolicyEvaluation {
  /** The evaluation's own id — what a requeue is addressed to. */
  evaluationId?: string;
  status?: string | null;
  /**
   * Build-validation evaluations carry the definition they ran here — and
   * whether that run is expired, i.e. superseded by later commits on the branch.
   */
  context?: { buildDefinitionName?: string; isExpired?: boolean; buildId?: number } | null;
  configuration?: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { id?: string; displayName?: string };
    /**
     * Policy-type-specific settings. A build-validation policy names itself with
     * `displayName`; a status policy is identified by its `statusGenre`/
     * `statusName` pair, and separately carries `defaultDisplayName`, the label
     * Azure renders for it on the pull request page.
     */
    settings?: { displayName?: string; statusName?: string; statusGenre?: string; defaultDisplayName?: string };
  };
}

/**
 * The operator-facing name of a policy, however its type happens to carry one.
 *
 * The `context` and type-name arms are why a nameless policy is no longer skipped
 * downstream: `settings.displayName` is null for every build-validation policy
 * whose operator never typed one — which on a real repo is most of them, the
 * required builds included — leaving the definition name in `context` as the only
 * thing a `ci.checks` glob could ever match.
 */
export function policyDisplayName(e: RawPolicyEvaluation): string {
  const s = e.configuration?.settings;
  if (s?.displayName) return s.displayName;
  if (s?.statusName) return s.statusGenre ? `${s.statusGenre}/${s.statusName}` : s.statusName;
  if (e.context?.buildDefinitionName) return e.context.buildDefinitionName;
  return e.configuration?.type?.displayName ?? '';
}

/**
 * The *other* names this policy answers to, so a `ci.checks` glob written against
 * any of them claims the check.
 *
 * A status policy has two names and they are not the same string: the harness
 * keys it by `statusGenre/statusName` (`pr-agent-review/reviewed`), while the
 * label on the pull request page comes from `settings.defaultDisplayName`
 * (`PR-Agent-Reviewed`). An operator writing a rule copies what they can see, so
 * before this the obvious glob matched nothing, silently — the same failure mode
 * as the nameless build policies above.
 *
 * An *alias*, not a replacement: {@link policyDisplayName} still decides the
 * check's name, so nothing an existing rule matched stops matching and no
 * cockpit row is renamed under an operator who was reading it.
 */
export function policyDisplayAliases(e: RawPolicyEvaluation): string[] {
  const primary = policyDisplayName(e);
  const alias = e.configuration?.settings?.defaultDisplayName;
  return alias && alias !== primary ? [alias] : [];
}

/** Extra attempts after the first for a *transient* failure (sign-in HTML, 429, 5xx, network). */
const MAX_RETRIES = 2;
/** Base backoff between retries, multiplied by the attempt number. */
const RETRY_BACKOFF_MS = 300;

/** Real delay; injectable in the client so tests don't actually wait. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Does this look like Azure's sign-in HTML page rather than the JSON we asked for?
 *
 * Azure DevOps answers a *rejected* credential not with a JSON 401 but — maddeningly —
 * with a 2xx (often `203 Non-Authoritative`) serving the interactive sign-in page. It
 * passes a naive `res.ok` check, so `JSON.parse` then crashes on the leading `<` with an
 * opaque `Unexpected token '<'`. Detecting it lets the client retry (usually a transient
 * token blip) and, failing that, throw an error that actually names the cause. Pure so it
 * stays unit-testable.
 */
export function isSignInHtml(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*<(?:!doctype|html)\b/i.test(body);
}

/**
 * Is this rejected PATCH Azure saying the relation is already on the work item?
 *
 * Adding a link a work item already carries is a 400, not a 409, and it is the one
 * 400 the linking path must not surface: the caller asked for a link and the link
 * is there. Matched on the exception type key rather than the prose, which is
 * localised — the message is checked too, for a deployment that answers only the
 * sentence. Pure so it stays unit-testable, like {@link isSignInHtml}.
 */
export function isRelationAlreadyExists(message: string): boolean {
  return /WorkItemRelationAlreadyExists|relation already exists/i.test(message);
}

/**
 * The real {@link AzureDevOpsApi}: one bound `organization`/`project`/`repository`,
 * all HTTP behind `fetch`, mapping Azure's responses down to the minimal `Az*`
 * shapes the integrations consume. All Azure DevOps HTTP (and auth) lives here —
 * nothing else in the repo touches the network — so the integrations stay
 * network-free and unit-testable.
 */
export class RestAzureDevOpsApi implements AzureDevOpsApi {
  private viewer: string | null = null;
  /**
   * Validators for the GET responses Azure volunteered one for. Opportunistic
   * and server-driven: see `conditionalRequests.ts` for what it does and does
   * not cover on this provider.
   */
  private readonly etags = new AzureEtagCache();
  /** The bound project's GUID, resolved once — the policy artifactId needs the id, not the name. */
  private projectId: string | null = null;
  /** The bound repository's GUID, resolved once — a work-item artifact link needs the id, not the name. */
  private repositoryId: string | null = null;

  constructor(
    private readonly organization: string,
    private readonly project: string,
    private readonly repository: string,
    private readonly auth: AzureAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * Diagnostic sink for a request that failed every attempt — wired to the error log
     * in prod, silent by default. A retry that recovers writes nothing here.
     */
    private readonly log: (message: string) => void = () => {},
    /** Injectable backoff so tests don't wait real milliseconds. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  static create(
    cfg: { organization: string; project: string; repository: string },
    auth: AzureAuth,
    log?: (message: string) => void,
  ): RestAzureDevOpsApi {
    return new RestAzureDevOpsApi(cfg.organization, cfg.project, cfg.repository, auth, fetch, log);
  }

  private get orgUrl(): string {
    return `https://dev.azure.com/${encodeURIComponent(this.organization)}`;
  }
  private get projectUrl(): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}`;
  }
  private get repoUrl(): string {
    return `${this.projectUrl}/_apis/git/repositories/${encodeURIComponent(this.repository)}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    // Only a GET is ever validated. A write has no business in a read cache, and
    // the validator is only offered when the server volunteered one for this
    // exact URL last time — see `conditionalRequests.ts` for why this layer
    // makes no claim about which Azure endpoints answer 304.
    const cached = method === 'GET' ? this.etags.get(url) : undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // The previous attempt hit a *transient* failure. Force a fresh token in case a
        // stale/lagging one caused it (the `az`-CLI token can need a beat to propagate
        // after a refresh), then back off. Nothing is recorded here: a blip the next
        // attempt clears is not a fault, and recording it made a self-healing retry
        // read in the Errors panel exactly like a rejected credential.
        this.auth.forceRefresh?.();
        await this.sleep(RETRY_BACKOFF_MS * attempt);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: {
            Authorization: await this.auth.header(),
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(cached ? { 'If-None-Match': cached.etag } : {}),
            ...init.headers,
          },
        });
      } catch (err) {
        // Network-level failure (DNS, reset, timeout) — transient, worth another try.
        lastError = new Error(`Azure DevOps ${method} ${url}: network error: ${(err as Error).message}`);
        continue;
      }

      const body = await res.text().catch(() => '');
      const contentType = res.headers.get('content-type');

      // The server has just said the reading we hold is still current. That is a
      // *fresh* answer that cost no transfer, not a degraded one — nothing here
      // may set anything resembling `stale`. Checked before `res.ok`, which is
      // false for a 304 and would otherwise turn it into a hard 4xx failure.
      if (res.status === 304 && cached) return JSON.parse(cached.body) as T;

      if (!res.ok) {
        lastError = new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} ${res.statusText} ` +
            `(${contentType ?? 'no content-type'}): ${body.slice(0, 300)}`,
        );
        // Throttling (429) and server errors (5xx) can clear on a retry; a 4xx is a
        // definitive auth/permission/not-found answer — fail fast with the legible message.
        if (res.status === 429 || res.status >= 500) continue;
        throw lastError;
      }

      // A no-content success (e.g. a 204 from a label DELETE) has nothing to parse.
      if (body.trim() === '') return undefined as T;

      // A 2xx can still be Azure's sign-in HTML page when the credential was transiently
      // rejected — the notorious `Unexpected token '<'`. Retry it (a fresh token usually
      // clears it) rather than letting JSON.parse crash on the leading `<`.
      if (isSignInHtml(contentType, body)) {
        lastError = new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} returned an HTML sign-in page instead of JSON — ` +
            `the credential was rejected. Check \`az login\` (or AZURE_DEVOPS_PAT) and the organization name. ` +
            `Body: ${body.slice(0, 200)}`,
        );
        continue;
      }

      try {
        const parsed = JSON.parse(body) as T;
        // Store only what the server itself offered a validator for, so the next
        // read of this URL can be asked conditionally. An endpoint that sends no
        // ETag is never stored and never asked — this layer is a no-op for it.
        const etag = res.headers.get('etag');
        if (method === 'GET' && res.status === 200 && etag) this.etags.set(url, etag, body);
        return parsed;
      } catch {
        // 2xx, not HTML, but unparseable — genuinely malformed; a retry won't help.
        throw new Error(
          `Azure DevOps ${method} ${url} -> ${res.status} returned invalid JSON ` +
            `(${contentType ?? 'no content-type'}): ${body.slice(0, 200)}`,
        );
      }
    }

    // Every attempt was spent on a transient failure, so the blip was not one: record
    // it, naming the attempts, and throw. A caller that degrades to its last good
    // reading swallows the throw, which is why the recording happens here.
    const exhausted = lastError ?? new Error(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES} retries`);
    this.log(`Azure DevOps ${method} ${url}: failed after ${MAX_RETRIES + 1} attempts — ${exhausted.message}`);
    throw exhausted;
  }

  private withApiVersion(url: string, params: Record<string, string> = {}, apiVersion: string = API_VERSION): string {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('api-version', apiVersion);
    return u.toString();
  }

  async viewerUniqueName(): Promise<string> {
    // Stable for the auth lifetime, so fetch it once.
    if (this.viewer === null) {
      const data = await this.request<{
        authenticatedUser?: { properties?: { Account?: { $value?: string } }; providerDisplayName?: string };
      }>(this.withApiVersion(`${this.orgUrl}/_apis/connectionData`, {}, CONNECTION_DATA_API_VERSION));
      const user = data.authenticatedUser;
      this.viewer = user?.properties?.Account?.$value ?? user?.providerDisplayName ?? '';
    }
    return this.viewer;
  }

  async listActivePullRequests(): Promise<AzPull[]> {
    const data = await this.request<{ value: RawPull[] }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests`, { 'searchCriteria.status': 'active', $top: '100' }),
    );
    return data.value.map((p) => ({
      pullRequestId: p.pullRequestId,
      title: p.title,
      branch: stripRef(p.sourceRefName),
      baseBranch: stripRef(p.targetRefName),
      lastMergeSourceCommit: p.lastMergeSourceCommit?.commitId ?? '',
      authorUniqueName: p.createdBy?.uniqueName ?? '',
      authorDisplayName: p.createdBy?.displayName ?? '',
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${p.pullRequestId}`,
      isDraft: p.isDraft ?? false,
      mergeStatus: p.mergeStatus ?? 'notSet',
      reviewers: (p.reviewers ?? []).map((r) => ({
        uniqueName: r.uniqueName ?? '',
        vote: r.vote ?? 0,
        isRequired: r.isRequired ?? false,
        // Absent means an individual: Azure sets the flag only on the entries that
        // are groups, so defaulting it the other way would read every reviewer as
        // a team and drop the assignment on all of them.
        isContainer: r.isContainer ?? false,
      })),
    }));
  }

  async listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]> {
    // `queryTimeRangeType=closed` + `minTime` is the server-side window; `status=all`
    // is what makes one request cover both completions and abandonments (asking for
    // each separately would double the cost of the feature). The client-side filter
    // below is not redundant: the range is inclusive at the boundary, and an org on
    // an older API version that ignores the time parameters must still not be able
    // to flood the world with a year of closed PRs.
    const data = await this.request<{ value: RawClosedPull[] }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests`, {
        'searchCriteria.status': 'all',
        'searchCriteria.queryTimeRangeType': 'closed',
        'searchCriteria.minTime': since,
        $top: '100',
      }),
    );
    const out: AzClosedPull[] = [];
    for (const p of data.value) {
      if (p.status !== 'completed' && p.status !== 'abandoned') continue;
      const closedAt = p.closedDate;
      if (!withinClosedWindow(closedAt, since)) continue;
      out.push({
        pullRequestId: p.pullRequestId,
        title: p.title,
        branch: stripRef(p.sourceRefName),
        baseBranch: stripRef(p.targetRefName),
        authorUniqueName: p.createdBy?.uniqueName ?? '',
        url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${p.pullRequestId}`,
        merged: p.status === 'completed',
        closedAt,
        mergeCommitSha: p.status === 'completed' ? (p.lastMergeCommit?.commitId ?? null) : null,
      });
    }
    return out;
  }

  async listPullThreads(pullRequestId: number): Promise<AzThread[]> {
    const data = await this.request<{ value: RawThread[] }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
    );
    return data.value.map((t) => ({
      id: t.id,
      status: t.status ?? null,
      // Azure leads with the right-hand side, which is the line as the change
      // leaves it — the one a reader opening the file would look at. A thread on
      // a deleted line has only the left, and one on no file has neither.
      filePath: t.threadContext?.filePath ?? null,
      line: t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line ?? null,
      comments: (t.comments ?? []).map((c) => ({
        id: c.id,
        authorUniqueName: c.author?.uniqueName ?? '',
        content: c.content ?? '',
        parentCommentId: c.parentCommentId ?? null,
        commentType: c.commentType ?? 'text',
      })),
    }));
  }

  /** Resolve (and cache) the bound project's GUID — the policy artifactId needs the id, not the name. */
  private async resolveProjectId(): Promise<string> {
    if (this.projectId === null) {
      // The projects endpoint accepts either a name or an id, so passing the
      // configured project name works whether it was already a GUID or not.
      const data = await this.request<{ id?: string }>(
        this.withApiVersion(`${this.orgUrl}/_apis/projects/${encodeURIComponent(this.project)}`),
      );
      this.projectId = data.id ?? '';
    }
    return this.projectId;
  }

  /**
   * Resolve (and cache) the bound repository's GUID. The repositories endpoint takes
   * a name or an id, exactly as the projects one does, so this works whichever the
   * operator configured — and a pull-request artifact link needs the id.
   */
  private async resolveRepositoryId(): Promise<string> {
    if (this.repositoryId === null) {
      const data = await this.request<{ id?: string }>(this.withApiVersion(this.repoUrl));
      this.repositoryId = data.id ?? '';
    }
    return this.repositoryId;
  }

  async listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]> {
    const projectId = await this.resolveProjectId();
    // A PR is addressed as a "CodeReview" artifact; the id must carry the project GUID.
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    const data = await this.request<{ value: RawPolicyEvaluation[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/policy/evaluations`, { artifactId }, POLICY_API_VERSION),
    );
    return data.value.map((e) => ({
      evaluationId: e.evaluationId,
      typeId: e.configuration?.type?.id ?? '',
      displayName: policyDisplayName(e),
      displayAliases: policyDisplayAliases(e),
      typeName: e.configuration?.type?.displayName ?? '',
      buildDefinitionName: e.context?.buildDefinitionName,
      buildId: e.context?.buildId,
      status: e.status ?? null,
      isExpired: e.context?.isExpired,
      isBlocking: e.configuration?.isBlocking ?? false,
      isEnabled: e.configuration?.isEnabled ?? false,
    }));
  }

  /**
   * Requeue one policy evaluation (issue #395). A body-less PATCH: the endpoint's
   * whole meaning is "run this again", and there is nothing to say about it.
   *
   * The response is the evaluation as it stands *after* the requeue, and it is
   * read rather than discarded because a 200 is not the same as a restart — a
   * policy Azure declines to requeue (a definition the token cannot queue, a
   * policy that has since been disabled) answers with the record unchanged, and
   * `isExpired` still true is the only signal before the next snapshot.
   */
  async requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue> {
    const data = await this.request<RawPolicyEvaluation>(
      this.withApiVersion(
        `${this.projectUrl}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}`,
        {},
        POLICY_API_VERSION,
      ),
      { method: 'PATCH' },
    );
    // A deployment that answers 204 leaves `request` with nothing to parse, which
    // is a requeue that said nothing about itself — taken at its word rather than
    // read as expired, since the alternative is falling back to an agent on every
    // successful write.
    return { status: data?.status ?? null, isExpired: data?.context?.isExpired };
  }

  async getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]> {
    const data = await this.request<{ records?: RawTimelineRecord[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/timeline`),
    );
    return (data.records ?? []).map((r) => ({
      type: r.type ?? '',
      name: r.name ?? '',
      result: r.result ?? null,
      logId: r.log?.id ?? null,
      issues: (r.issues ?? []).map((i) => ({ type: i.type ?? '', message: i.message ?? '' })),
    }));
  }

  async getBuildLog(buildId: number, logId: number): Promise<string[]> {
    // Asked as JSON — the same `Accept` every other read here sends — because the
    // endpoint answers a `{count, value: [...lines]}` envelope for it and raw
    // text otherwise, and `request` parses JSON. The `value` guard covers a
    // deployment that answers text anyway: no lines beats a thrown dispatch.
    const data = await this.request<{ value?: string[] }>(
      this.withApiVersion(`${this.projectUrl}/_apis/build/builds/${buildId}/logs/${logId}`),
    );
    return Array.isArray(data?.value) ? data.value : [];
  }

  async listPullLabels(pullRequestId: number): Promise<string[]> {
    const data = await this.request<{ value: Array<{ name?: string }> }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/labels`),
    );
    return data.value.map((l) => l.name ?? '').filter((name) => name !== '');
  }

  async listOpenWorkItems(tag?: string, assignedTo?: string): Promise<AzWorkItem[]> {
    // Two-step: WIQL returns the matching ids, then a batch read hydrates fields
    // and relations. WIQL can't return fields directly, so the batch is required.
    return this.runWorkItemQuery(buildOpenWorkItemQuery(tag, assignedTo));
  }

  async listWorkItemsChangedSince(since: string, tag?: string, assignedTo?: string): Promise<AzWorkItem[]> {
    // Time precision, because the clause carries a time: see runWorkItemQuery.
    return this.runWorkItemQuery(buildWorkItemHistoryQuery(since, tag, assignedTo), true);
  }

  /**
   * The shared two-step behind both work-item listings: ids from WIQL, fields from the batch read.
   *
   * A WIQL query runs at **date** precision unless the request asks otherwise, and a
   * date-precision query faults outright on a comparison that supplies a time — a 400
   * with `VssPropertyValidationException`, every pulse. So a query whose clauses carry
   * a time must ask for `timePrecision`; only the changed-since read does.
   *
   * It goes in the **query string**, not the body: the `Wiql` request body is defined as
   * `{query}` alone, so the server drops an unknown body field without complaining and
   * the fault is the one it was meant to fix, unchanged.
   */
  private async runWorkItemQuery(wiql: string, timePrecision = false): Promise<AzWorkItem[]> {
    const query = await this.request<{ workItems?: Array<{ id: number }> }>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/wiql`, timePrecision ? { timePrecision: 'true' } : {}),
      { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );
    const ids = (query.workItems ?? []).map((w) => w.id);
    return this.getWorkItems(ids);
  }

  /**
   * The batch read, shared by the open-item list and relation hydration. Azure
   * caps a batch at 200 ids, and `errorPolicy: 'omit'` is what keeps one dead id
   * — a deleted parent, an item in a project this identity cannot read — from
   * faulting the whole request and, through it, the snapshot.
   */
  async getWorkItems(ids: number[]): Promise<AzWorkItem[]> {
    if (ids.length === 0) return [];
    const items: AzWorkItem[] = [];
    for (const chunk of chunkIds(ids, 200)) {
      const batch = await this.request<{ value: RawWorkItem[] }>(
        this.withApiVersion(`${this.orgUrl}/_apis/wit/workitemsbatch`),
        { method: 'POST', body: JSON.stringify({ ids: chunk, $expand: 'Relations', errorPolicy: 'omit' }) },
      );
      // An omitted id comes back as a null-ish entry rather than being absent.
      for (const w of batch.value) if (w && typeof w.id === 'number') items.push(this.mapWorkItem(w));
    }
    return items;
  }

  async listWorkItemUpdates(id: number): Promise<AzWorkItemUpdate[]> {
    const data = await this.request<{ value: RawWorkItemUpdate[] }>(
      this.withApiVersion(`${this.orgUrl}/_apis/wit/workItems/${id}/updates`),
    );
    return data.value.map((u) => {
      const tags = u.fields?.['System.Tags'];
      return {
        revisedByUniqueName: u.revisedBy?.uniqueName ?? '',
        tagsOld: tags?.oldValue,
        tagsNew: tags?.newValue,
      };
    });
  }

  private mapWorkItem(w: RawWorkItem): AzWorkItem {
    const fields = w.fields ?? {};
    const rawTags = String(fields['System.Tags'] ?? '');
    return {
      id: w.id,
      title: String(fields['System.Title'] ?? ''),
      body: String(fields['System.Description'] ?? ''),
      state: String(fields['System.State'] ?? ''),
      tags: rawTags
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      workItemType: String(fields['System.WorkItemType'] ?? ''),
      areaPath: String(fields['System.AreaPath'] ?? ''),
      createdAt: String(fields['System.CreatedDate'] ?? ''),
      changedAt: String(fields['System.ChangedDate'] ?? ''),
      relationUrls: (w.relations ?? [])
        .filter((r) => r.rel === 'ArtifactLink' && typeof r.url === 'string')
        .map((r) => r.url as string),
      parentId: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Reverse')[0] ?? null,
      childIds: hierarchyIds(w.relations, 'System.LinkTypes.Hierarchy-Forward'),
      url: `${this.projectUrl}/_workitems/edit/${w.id}`,
    };
  }

  async createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef> {
    // The created comment's own id comes back in the response body, and it is the
    // id the next thread read will carry — the one thing that lets attribution
    // recognise this reply as the fleet's rather than guess from its author.
    // Left unset when Azure answers without one; the caller must not invent it.
    const created = await this.request<{ id?: number }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}/comments`),
      { method: 'POST', body: JSON.stringify({ content, parentCommentId, commentType: 'text' }) },
    );
    return {
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}`,
      ...(typeof created?.id === 'number' ? { id: created.id } : {}),
    };
  }

  /**
   * Resolve (or otherwise re-status) a thread. A PATCH on the thread itself
   * rather than on a comment: Azure's resolution verdict lives on the thread, and
   * it is what `buildUnresolvedComments` reads back.
   */
  async setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async createThread(pullRequestId: number, content: string): Promise<AzCommentRef> {
    // A *new* thread, so nothing here is a reply into an existing one and no
    // attribution row is ever keyed on it. Both ids are still reported when Azure
    // gives them, so the two create paths answer in one shape — and the thread's
    // own id is what a later resolution of it is recognised by.
    const created = await this.request<{ id?: number; comments?: { id?: number }[] }>(
      this.withApiVersion(`${this.repoUrl}/pullRequests/${pullRequestId}/threads`),
      { method: 'POST', body: JSON.stringify({ comments: [{ content, commentType: 'text' }], status: 'active' }) },
    );
    const id = created?.comments?.[0]?.id;
    const threadId = created?.id;
    return {
      url: `${this.projectUrl}/_git/${encodeURIComponent(this.repository)}/pullrequest/${pullRequestId}`,
      ...(typeof id === 'number' ? { id } : {}),
      ...(typeof threadId === 'number' ? { threadId } : {}),
    };
  }

  async completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult> {
    const data = await this.request<{ status?: string }>(
      this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`),
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'completed',
          lastMergeSourceCommit: { commitId: lastMergeSourceCommit },
          completionOptions: { mergeStrategy: mergeStrategyFor(method), deleteSourceBranch: false },
        }),
      },
    );
    return { status: data.status ?? 'unknown' };
  }

  /**
   * Abandon a pull request. The same PATCH `completePullRequest` makes, with the
   * one field that matters and none of the merge machinery — no
   * `lastMergeSourceCommit`, because nothing is being merged and Azure does not
   * ask for one to abandon.
   */
  async abandonPullRequest(pullRequestId: number): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    });
  }

  async setWorkItemState(id: number, state: string): Promise<void> {
    // Work item updates are a JSON Patch document, not a plain JSON body — the
    // dedicated content type is required or Azure rejects the request. `add` on an
    // existing field replaces it, so this doubles as an idempotent set.
    await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    });
  }

  async createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.request<{ id?: number }>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/workItems/${id}/comments`, {}, WORK_ITEM_COMMENTS_API_VERSION),
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    return { id: data.id ?? 0 };
  }

  async updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef> {
    const data = await this.request<{ id?: number }>(
      this.withApiVersion(
        `${this.projectUrl}/_apis/wit/workItems/${id}/comments/${commentId}`,
        {},
        WORK_ITEM_COMMENTS_API_VERSION,
      ),
      { method: 'PATCH', body: JSON.stringify({ text }) },
    );
    return { id: data.id ?? commentId };
  }

  /**
   * The write behind Azure's **Check for linked work items** policy.
   *
   * The link is a relation on the *work item*, not a field on the pull request:
   * Azure derives a pull request's `workItemRefs` from these, and the create-PR
   * payload's `workItemRefs` is read-only, so there is no way to open a pull request
   * already linked. Hence a second call, and hence this being a work-item API method
   * rather than a git one.
   *
   * The artifact id is `{projectId}/{repositoryId}/{pullRequestId}` **URL-encoded
   * into the vstfs path** — the separators are `%2F` inside a single path segment,
   * not real slashes. Azure stores it exactly as sent, which is why
   * `linkedPrFromRelations` reads either form: a link a human made through the web
   * UI comes back the same way, and one written any other way is not a link Azure's
   * policy recognises.
   *
   * A duplicate is absorbed rather than thrown. The desk's row and the world's
   * `linkedPrNumber` already make a repeat rare, but the two race across a pulse
   * boundary, and "the link you asked for is there" is not a failure worth an entry
   * in the operator's Errors panel.
   */
  async linkWorkItemToPull(id: number, pullRequestId: number): Promise<void> {
    const [projectId, repositoryId] = await Promise.all([this.resolveProjectId(), this.resolveRepositoryId()]);
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2F${repositoryId}%2F${pullRequestId}`;
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            // `name` is what the work item's Development section labels the link.
            // Azure defaults it to the artifact type, so omitting it is not neutral:
            // the link renders unnamed and reads as somebody's hand-made mistake.
            value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  async createWorkItem(input: {
    type: string;
    title: string;
    description: string;
    tags: string[];
    assignedTo: string | null;
  }): Promise<{ id: number }> {
    // The type is a path segment — `$Bug`, `$User Story` — and the URL-encoded
    // space is why the type travels as a name rather than an id: what a project
    // calls its types is process-template data, and the name is the only handle an
    // operator can put in config.
    const url = `${this.projectUrl}/_apis/wit/workitems/$${encodeURIComponent(input.type)}`;
    const patch: { op: string; path: string; value: string }[] = [
      { op: 'add', path: '/fields/System.Title', value: input.title },
      { op: 'add', path: '/fields/System.Description', value: input.description },
    ];
    // Semicolon-delimited, the one shape `setWorkItemTag` also writes.
    if (input.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
    if (input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
    const data = await this.request<{ id: number }>(this.withApiVersion(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });
    return { id: data.id };
  }

  async relateWorkItem(id: number, relatedId: number): Promise<void> {
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Related',
              url: `${this.orgUrl}/_apis/wit/workItems/${relatedId}`,
            },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  /**
   * The project's area tree, flattened depth-first.
   *
   * `$depth=<n>` rather than a walk: Azure returns the whole subtree in one call,
   * and paging it a level at a time would cost a request per node for a list the
   * harness reads at most once an hour. The depth is bounded rather than
   * unlimited because the parameter has no "all" — a tree deeper than this is one
   * whose leaves nobody navigates to anyway.
   *
   * `name` is a node's own label and `path` its full address; only the address is
   * a value `System.AreaPath` accepts, so that is what is carried. Azure writes
   * the root as `\<Project>\Area`, which is not the form the field takes — the
   * `\Area` infix is dropped here so the strings offered are the strings that can
   * be written back.
   */
  async listAreaPaths(): Promise<AreaPathTree> {
    const data = await this.request<RawClassificationNode>(
      this.withApiVersion(`${this.projectUrl}/_apis/wit/classificationnodes/areas`, { $depth: String(AREA_DEPTH) }),
    );
    const root = areaNodePath(data) ?? this.project;
    const paths: string[] = [];
    const walk = (node: RawClassificationNode): void => {
      for (const child of node.children ?? []) {
        const path = areaNodePath(child);
        if (path !== null) paths.push(path);
        walk(child);
      }
    };
    walk(data);
    return { root, paths };
  }

  async setWorkItemParent(id: number, parentId: number): Promise<void> {
    try {
      await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: `${this.orgUrl}/_apis/wit/workItems/${parentId}`,
            },
          },
        ]),
      });
    } catch (err) {
      if (!isRelationAlreadyExists((err as Error).message)) throw err;
    }
  }

  async setWorkItemAreaPath(id: number, areaPath: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.AreaPath', value: areaPath }]),
    });
  }

  async setWorkItemTag(id: number, tag: string, present: boolean): Promise<void> {
    // System.Tags is a single semicolon-delimited string, so a tag add/remove is a
    // read-modify-write: fetch current tags, adjust the set, PATCH the whole field.
    const wi = await this.request<{ fields?: Record<string, unknown> }>(
      this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}?fields=System.Tags`),
    );
    const current = String(wi.fields?.['System.Tags'] ?? '')
      .split(';')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    const tags = new Set(current);
    if (present) tags.add(tag);
    else tags.delete(tag);
    await this.request(this.withApiVersion(`${this.orgUrl}/_apis/wit/workitems/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.Tags', value: [...tags].join('; ') }]),
    });
  }

  async createPull(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ pullRequestId: number }> {
    const data = await this.request<{ pullRequestId: number }>(this.withApiVersion(`${this.repoUrl}/pullrequests`), {
      method: 'POST',
      body: JSON.stringify({
        sourceRefName: headsRef(input.head),
        targetRefName: headsRef(input.base),
        title: input.title,
        description: input.body,
      }),
    });
    return { pullRequestId: data.pullRequestId };
  }

  async setPullTitle(pullRequestId: number, title: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async setPullBase(pullRequestId: number, base: string): Promise<void> {
    await this.request(this.withApiVersion(`${this.repoUrl}/pullrequests/${pullRequestId}`), {
      method: 'PATCH',
      body: JSON.stringify({ targetRefName: headsRef(base) }),
    });
  }

  /**
   * Delete a branch. Azure has no delete verb for a ref: you *update* it to the zero
   * object id, and the update is optimistic — it needs the id the ref currently
   * points at. So this is two calls, and the first one is also the already-gone
   * check: a filter that matches no ref means the branch is not there, which the
   * reap treats as success rather than as a failure to delete.
   */
  async deleteBranch(branch: string): Promise<boolean> {
    const plain = branch.replace(/^refs\/heads\//, '');
    const refs = await this.request<{ value: { name: string; objectId: string }[] }>(
      this.withApiVersion(`${this.repoUrl}/refs`, { filter: `heads/${plain}` }),
    );
    // The filter is a prefix match, so `heads/issue/12` also returns `issue/120`.
    // Only an exact name is this branch.
    const ref = refs.value.find((r) => r.name === headsRef(plain));
    if (!ref) return false;
    await this.request(this.withApiVersion(`${this.repoUrl}/refs`), {
      method: 'POST',
      body: JSON.stringify([{ name: ref.name, oldObjectId: ref.objectId, newObjectId: ZERO_OBJECT_ID }]),
    });
    return true;
  }

  async setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void> {
    const labelsUrl = `${this.repoUrl}/pullRequests/${pullRequestId}/labels`;
    if (present) {
      // POST is idempotent-ish: re-adding an existing label just returns it.
      await this.request(this.withApiVersion(labelsUrl), { method: 'POST', body: JSON.stringify({ name: label }) });
    } else {
      // DELETE by label name; a 404 (label not present) is a no-op for our purposes.
      try {
        await this.request(this.withApiVersion(`${labelsUrl}/${encodeURIComponent(label)}`), { method: 'DELETE' });
      } catch (err) {
        if (!/-> 404\b/.test((err as Error).message)) throw err;
      }
    }
  }
}

/**
 * A plain branch name as the full ref Azure's PR API expects.
 *
 * The read side strips this prefix (`sourceControl.ts`), so every branch inside the
 * harness is plain and the conversion belongs at the one boundary that needs it —
 * a second stripper elsewhere is how the two ends come to disagree about whether a
 * branch is `main` or `refs/heads/main`.
 */
function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

/**
 * WIQL selecting open work items in the bound project, optionally narrowed to a tag
 * and/or an assignee (uniqueName/UPN). Both narrowings are independent AND clauses, so
 * any combination — neither, either, both — composes.
 */
export function buildOpenWorkItemQuery(tag?: string, assignedTo?: string): string {
  return workItemQuery(["[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')"], tag, assignedTo);
}

/**
 * WIQL selecting work items in **any** state that changed at or after `since`,
 * under the same tag/assignee narrowing — the ticket mirror's query (issue #329).
 *
 * The state clause is dropped rather than inverted: this is a history, and a
 * mirror that could only see finished work would be missing every row the cockpit
 * shows as open. Exported for its own test beside {@link buildOpenWorkItemQuery},
 * because a mis-built WIQL fails as an empty result rather than as an error — a
 * tab with no rows, on a tracker that is full of them.
 */
export function buildWorkItemHistoryQuery(since: string, tag?: string, assignedTo?: string): string {
  return workItemQuery([`[System.ChangedDate] >= '${wiqlDate(since)}'`], tag, assignedTo);
}

/** The clauses both work-item queries share, so the two narrowings are written once. */
function workItemQuery(extra: string[], tag?: string, assignedTo?: string): string {
  const clauses = ['[System.TeamProject] = @project', ...extra];
  // Tags are matched with CONTAINS; a single-quote in a tag would break the query,
  // so escape it the SQL way (double the quote).
  if (tag) clauses.push(`[System.Tags] CONTAINS '${tag.replace(/'/g, "''")}'`);
  // AssignedTo matches the identity's uniqueName/UPN exactly; same single-quote escape.
  if (assignedTo) clauses.push(`[System.AssignedTo] = '${assignedTo.replace(/'/g, "''")}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id] ASC`;
}

/**
 * An ISO instant as WIQL will accept it: `YYYY-MM-DD HH:MM:SSZ`.
 *
 * WIQL rejects the `T` separator and sub-second precision, and rejects them by
 * faulting the whole query — as it also does to any time at all unless the request
 * sets `timePrecision` ({@link RestAzureDevOpsApi}), so the format and the flag are
 * one fix in two places. Quotes are stripped rather than escaped because
 * this value is never operator-supplied: it is the store's own high-water mark, and
 * anything unparseable is a bug here, not input.
 */
function wiqlDate(iso: string): string {
  return iso.replace(/'/g, '').replace('T', ' ').replace(/\.\d+/, '').replace(/Z?$/, 'Z');
}

/**
 * The work-item ids on one side of the hierarchy, read out of a work item's
 * relations. A hierarchy relation's `url` is the related item's REST address —
 * `…/_apis/wit/workItems/42` — so the trailing segment is the id.
 *
 * Pure, and exported for its own test: this is the one place the harness converts
 * an Azure URL into a work-item number, and a silently-unparsed url would present
 * as a tracker with no hierarchy at all rather than as an error.
 */
export function hierarchyIds(relations: RawWorkItem['relations'], rel: string): number[] {
  const ids: number[] = [];
  for (const r of relations ?? []) {
    if (r.rel !== rel || typeof r.url !== 'string') continue;
    const match = /\/workItems\/(\d+)(?:[?#].*)?$/i.exec(r.url);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}
