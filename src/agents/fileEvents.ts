import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// → docs/spec/10-agent-runtimes.md

export const HOOK_DEBUG_FILE = '_hook-debug.log';

const FILE_EVENTS_HOOK_SCRIPT =
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{' +
  'const dir=process.env.LUBBDUBB_EVENTS_DIR;if(!dir)return;const fs=require("fs");' +
  'const dbg=process.env.LUBBDUBB_EVENTS_DEBUG;' +
  'const log=(m)=>{try{if(dbg)fs.appendFileSync(dir+"/' +
  HOOK_DEBUG_FILE +
  '",Date.now()+" "+m+"\\n")}catch(e){}};' +
  'try{' +
  'const j=JSON.parse(d);const ti=j.tool_input||{};const p=ti.file_path||ti.notebook_path;' +
  'log("fired tool="+j.tool_name+" keys="+Object.keys(ti).join(",")+" path="+(p||"<none>"));' +
  'if(!p)return;' +
  'const n=Date.now()+"-"+Math.random().toString(36).slice(2);' +
  'const rec=JSON.stringify({path:p,tool:j.tool_name});' +
  'fs.writeFileSync(dir+"/"+n+".tmp",rec);fs.renameSync(dir+"/"+n+".tmp",dir+"/"+n+".json");' +
  '}catch(e){log("error "+(e&&e.message))}})';

export const FILE_EVENTS_SETTINGS = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: 'node', args: ['-e', FILE_EVENTS_HOOK_SCRIPT] }],
      },
    ],
  },
};

export interface FileEventRecord {
  path: string;
  tool: string | null;
}

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

function isUnderPrefix(pathSegs: string[], prefix: string | undefined): boolean {
  if (!prefix) return false;
  const p = prefix.split(/[\\/]/).filter(Boolean);
  const s = pathSegs.filter(Boolean);
  if (p.length === 0 || s.length <= p.length) return false;
  return p.every((seg, i) => seg.toLowerCase() === s[i]?.toLowerCase());
}

export class FileEventsSpool {
  constructor(private readonly base: string) {
    mkdirSync(base, { recursive: true });
  }

  dirFor(key: string): string {
    const dir = join(this.base, key);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  drain(key: string): FileEventRecord[] {
    const dir = join(this.base, key);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    files.sort();
    const out: FileEventRecord[] = [];
    for (const f of files) {
      const path = join(dir, f);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
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

  readDebug(key: string): string[] {
    try {
      return readFileSync(join(this.base, key, HOOK_DEBUG_FILE), 'utf8')
        .split('\n')
        .filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  dispose(key: string): void {
    try {
      rmSync(join(this.base, key), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
