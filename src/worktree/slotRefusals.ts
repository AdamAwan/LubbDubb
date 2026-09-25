import { describe, type Blocked, type Condemnation, type Request, type SalvageReport } from './slots.js';

// → docs/spec/09-execution.md#exhaustion

export const RMDIR_RETRIES = 5;
export const RMDIR_RETRY_DELAY_MS = 200;

export function reclaimFailure(dir: string, err: NodeJS.ErrnoException): string {
  const held = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
  if (!held) return `Cannot reclaim the worktree directory ${dir}: ${err.message}`;
  return (
    `Cannot reclaim the worktree directory ${dir}: it is held open by another process (${err.code}), ` +
    `and was still held after ${RMDIR_RETRIES} retries over ` +
    `${(RMDIR_RETRIES * RMDIR_RETRY_DELAY_MS) / 1000}s. That is almost always a process an earlier agent ` +
    `started and left running — a shell, a watcher, a test runner — whose working directory is still ` +
    `inside it; on Windows being a live process's cwd is by itself enough to refuse the removal. ` +
    `Everything the harness could find standing in the directory has already been terminated, so ` +
    `this one is outside what it can see. Stop that process and the branch dispatches again on the ` +
    `next cycle; until then every dispatch onto it will fail here.`
  );
}

export function checkedOutElsewhere(branch: string, path: string, worktreeRoot: string): string {
  return (
    `Cannot lease a worktree for ${branch}: it is already checked out at ${path}, which is not a pool slot ` +
    `(the pool is ${worktreeRoot}). Git refuses to check one branch out twice, and this checkout is not ` +
    `the harness's to switch — it is most likely the repository's own working copy. Switch it to another ` +
    `branch and the dispatch goes through on the next pulse.`
  );
}

export function reapBlockedByCheckout(branch: string, path: string): string {
  return (
    `Cannot reap ${branch}: it is checked out at ${path}, the repository's own working copy, which is not ` +
    `the harness's to switch — detaching it would move an operator off their branch without asking. Git ` +
    `refuses to delete a branch that is checked out, so the local ref and the remote copy both stay. Switch ` +
    `that checkout to another branch and the reap completes on the next pulse.`
  );
}

export function exhausted(
  req: Request,
  blocked: Blocked[],
  salvage: SalvageReport,
  pool: { size: number; root: string },
  strays: string[],
): string {
  return (
    `No free worktree slot for ${describe(req)}: all ${pool.size} slots under ${pool.root} are ` +
    `unavailable — ${blocked.map((b) => `${b.path} (${b.reason})`).join('; ')}. ` +
    (salvage.notes.length > 0 ? `Reclaim: ${salvage.notes.join('; ')}. ` : '') +
    'A slot is held while the harness has work in flight on the branch checked out in it, and a slot carrying ' +
    'uncommitted changes is stashed onto a salvage ref and reclaimed — so one still named above is one the ' +
    'stash itself refused. The bound follows the live agent cap, so raising the cap raises it too; the ' +
    'dispatch is retried next cycle either way.' +
    (strays.length === 0
      ? ''
      : ` Costing disk but not slots: ${strays.length} ${strays.length === 1 ? 'directory' : 'directories'} ` +
        `under ${pool.root} that git no longer knows about (${listed(strays)}). \`git worktree prune\` ` +
        'has already run, so nothing here will ever reach them again and they are safe to delete by hand; ' +
        'the harness will not, because this root is an operator setting and an unguarded delete under a ' +
        'mistyped one is unrecoverable.')
  );
}

export function firstLine(detail: string): string {
  const line = detail.split(/\r?\n/).find((l) => l.trim() !== '') ?? detail;
  return line.trim().length > CONDEMNED_REASON_CHARS
    ? `${line.trim().slice(0, CONDEMNED_REASON_CHARS - 1)}…`
    : line.trim();
}

const CONDEMNED_REASON_CHARS = 160;

export function revived(dir: string, condemnation: Condemnation): string {
  const gone =
    (condemnation.blockers ?? []).length > 0
      ? 'what was standing in the way of the checkout is no longer there'
      : 'the wipe it refused has now gone through';
  return (
    `Worktree slot ${dir} is back in the pool: it was taken out because ${condemnation.reason}, and ${gone}. ` +
    'It is handed over on the next dispatch that needs a slot, like any other.'
  );
}

export function salvaged(dir: string, ref: string): string {
  return (
    `Reclaimed worktree slot ${dir}, which was stranded carrying uncommitted changes. Nothing was discarded: ` +
    `its tracked edits, staged state and new files are stashed at ${ref} (\`git stash apply ${ref}\`). Ignored ` +
    'files are not stashed — a dependency tree does not belong in a git object, and the slot handles its own ' +
    "under the pool's usual rules. A slot needing this after every dispatch is a repository with tracked files " +
    'a build rewrites: untracking those is the fix, and until then this is where each copy goes.'
  );
}

function listed(paths: string[]): string {
  const named = paths.slice(0, STRAYS_NAMED);
  const rest = paths.length - named.length;
  return rest === 0 ? named.join(', ') : `${named.join(', ')}, and ${rest} more`;
}

const STRAYS_NAMED = 5;
