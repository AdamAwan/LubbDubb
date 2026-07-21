import type { PtyBackend, PtyProcess, SpawnOptions } from './backend.js';

/** A controllable fake process for tests: emit data, drive exit, observe writes. */
export class FakePtyProcess implements PtyProcess {
  readonly pid: number;
  writes: string[] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(pid = Math.floor(1000 + (Math.abs(hashString(String(Date.now()))) % 9000))) {
    this.pid = pid;
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (evt: { exitCode: number; signal?: number }) => void): void {
    this.exitCbs.push(cb);
  }
  write(data: string): void {
    this.writes.push(data);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(143); // 128 + SIGTERM
  }

  // -- test drivers --
  emit(data: string): void {
    for (const cb of this.dataCbs) cb(data);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

export class FakePtyBackend implements PtyBackend {
  readonly spawned: { command: string; args: string[]; opts: SpawnOptions; proc: FakePtyProcess }[] = [];
  private nextPid = 4000;

  spawn(command: string, args: string[], opts: SpawnOptions): FakePtyProcess {
    const proc = new FakePtyProcess(this.nextPid++);
    this.spawned.push({ command, args, opts, proc });
    return proc;
  }

  /** The most recently spawned process, for test assertions. */
  last(): FakePtyProcess {
    const entry = this.spawned[this.spawned.length - 1];
    if (!entry) throw new Error('nothing spawned yet');
    return entry.proc;
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
