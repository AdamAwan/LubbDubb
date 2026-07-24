import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Skill-agnostic artifact detection via a Claude Code `PostToolUse` hook.
 *
 * The flag sentinel (`@@LUBBDUBB_FLAG:…@@`) only surfaces an artifact if the
 * agent's *prompt* tells it to print the sentinel — so every skill that produces
 * a report has to know the protocol. A `PostToolUse` hook instead fires for
 * *any* file-writing tool (`Write`/`Edit`/…) regardless of what the agent was
 * told, so a report shows up with zero skill-side knowledge. The hook is wired
 * once into the launch `--settings` (both runtimes — hooks fire headless too),
 * mirroring the status-line capture in {@link file://./statusLine.ts}: a small
 * command dumps each write to a per-agent spool dir named by `$LUBBDUBB_EVENTS_DIR`
 * (set in the spawn env), and {@link FileEventsSpool} drains it back on demand.
 *
 * Detection is intentionally broad; the *promotion* decision (report vs. plain
 * code change) is a separate pure step, {@link classifyArtifact}.
 */

/**
 * The hook body: read the tool payload on stdin, pull just the written path (never
 * the file *content*), and drop a tiny `{path,tool}` record into the spool dir as
 * its own file (write-tmp-then-rename, so a concurrent drain never reads a partial
 * and parallel tool batches never interleave). No env var → no-op, like the
 * status-line command. `node` is always present — `claude` is a node CLI.
 */
const FILE_EVENTS_HOOK_COMMAND =
  'if [ -n "$LUBBDUBB_EVENTS_DIR" ]; then node -e \'' +
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{' +
  'const j=JSON.parse(d);const ti=j.tool_input||{};const p=ti.file_path||ti.notebook_path;' +
  'if(!p)return;const fs=require("fs");const dir=process.env.LUBBDUBB_EVENTS_DIR;' +
  'const n=Date.now()+"-"+Math.random().toString(36).slice(2);' +
  'const rec=JSON.stringify({path:p,tool:j.tool_name});' +
  'fs.writeFileSync(dir+"/"+n+".tmp",rec);fs.renameSync(dir+"/"+n+".tmp",dir+"/"+n+".json");' +
  "}catch(e){}})'; fi";

/**
 * The `--settings` fragment wiring the capture hook onto the file-writing tools.
 * The matcher is a tool-name regex; `Write`/`Edit`/`MultiEdit`/`NotebookEdit` are
 * the tools whose `tool_input` carries a `file_path`/`notebook_path`.
 */
export const FILE_EVENTS_SETTINGS = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: FILE_EVENTS_HOOK_COMMAND }],
      },
    ],
  },
};

/** One captured write: the path the tool wrote, and which tool wrote it (best-effort). */
export interface FileEventRecord {
  path: string;
  tool: string | null;
}

/** Parse one spooled record, or null if it's empty/unparsable/pathless. Pure. */
export function parseFileEventRecord(raw: string): FileEventRecord | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.path !== 'string' || !o.path.trim()) return null;
  return { path: o.path.trim(), tool: typeof o.tool === 'string' ? o.tool : null };
}

// Extensions we treat as a "report" the operator wants surfaced as an artifact
// chip, mapped to the chip `kind`. Everything else is just a tracked edit. Tune
// this allowlist to match what your skills emit.
const REPORT_KINDS: Record<string, string> = {
  md: 'report',
  markdown: 'report',
  html: 'report',
  htm: 'report',
  pdf: 'report',
  txt: 'report',
  rst: 'report',
  adoc: 'report',
  csv: 'data',
  tsv: 'data',
  svg: 'diagram',
};

/**
 * Decide whether a written path is a *report* (promote it to an artifact chip,
 * as the flag sentinel does today) or just a *code change* (track it in the
 * files list only). Promotes when the path is under one of `docsPrefix` (the
 * configured artifacts folder(s) — any extension) or under a `reports/` segment,
 * else falls back to the report/doc extension allowlist. Pure and stable per
 * path, so re-recording the same file is idempotent.
 *
 * `docsPrefix` accepts one prefix or a list; a **relative** entry matches the
 * worktree-relative path handed in, an **absolute** entry matches an
 * out-of-worktree write left absolute by `toWorktreeRelative` (e.g. `"D:/docs"`
 * matches `D:/docs/plans/cat.md`). The two never cross: a relative prefix's
 * leading segment can't equal an absolute path's drive/root segment, and vice
 * versa.
 */
export function classifyArtifact(path: string, docsPrefix?: string | string[]): { promoted: boolean; kind: string } {
  const segs = path.split(/[\\/]/);
  const base = segs[segs.length - 1] ?? path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const prefixes = docsPrefix === undefined ? [] : Array.isArray(docsPrefix) ? docsPrefix : [docsPrefix];
  if (prefixes.some((prefix) => isUnderPrefix(segs, prefix)))
    return { promoted: true, kind: REPORT_KINDS[ext] ?? 'report' };
  if (segs.some((s) => /^reports?$/i.test(s))) return { promoted: true, kind: REPORT_KINDS[ext] ?? 'report' };
  const kind = REPORT_KINDS[ext];
  return kind ? { promoted: true, kind } : { promoted: false, kind: 'file' };
}

/**
 * True when the path's leading segments match every segment of `prefix`
 * (separator-agnostic). Case-insensitive so a `D:/docs` prefix matches a
 * `D:\Docs\...` write — Windows reports either drive-letter/segment casing.
 */
function isUnderPrefix(pathSegs: string[], prefix: string | undefined): boolean {
  if (!prefix) return false;
  const p = prefix.split(/[\\/]/).filter(Boolean);
  const s = pathSegs.filter(Boolean);
  // A file *under* the prefix has strictly more segments than the prefix itself.
  if (p.length === 0 || s.length <= p.length) return false;
  return p.every((seg, i) => seg.toLowerCase() === s[i]?.toLowerCase());
}

/**
 * The read side: one spool dir per agent under `base`, each write a settled
 * `<ts>-<rand>.json` file. {@link drain} reads and removes them (oldest first by
 * name, which is timestamp-prefixed) so a record is delivered exactly once. All
 * best-effort — a missing dir or unreadable file just yields fewer records.
 */
export class FileEventsSpool {
  constructor(private readonly base: string) {
    mkdirSync(base, { recursive: true });
  }

  /** The dir a given key's writes land in; exported as LUBBDUBB_EVENTS_DIR at spawn. */
  dirFor(key: string): string {
    const dir = join(this.base, key);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Read-and-remove every settled record in the key's dir, oldest first. */
  drain(key: string): FileEventRecord[] {
    const dir = join(this.base, key);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return []; // dir gone or never created
    }
    files.sort(); // <ts>-<rand> prefix → chronological enough
    const out: FileEventRecord[] = [];
    for (const f of files) {
      const path = join(dir, f);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue; // raced with a rename; next drain catches it
      }
      const rec = parseFileEventRecord(raw);
      try {
        rmSync(path, { force: true });
      } catch {
        /* already gone */
      }
      if (rec) out.push(rec);
    }
    return out;
  }

  /** Drop a finished agent's spool dir entirely. Best-effort. */
  dispose(key: string): void {
    try {
      rmSync(join(this.base, key), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
