import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamJsonSession, type StreamChild } from '../src/agents/streamJsonSession.js';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  writes: string[] = [];
  stdinEnded = false;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = {
    write: (d: string) => this.writes.push(d),
    end: () => {
      this.stdinEnded = true;
    },
  } as unknown as NodeJS.WritableStream;
  raw(s: string): void {
    this.out.emit('data', s);
  }
  emitLine(obj: unknown): void {
    this.raw(JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

function session(): { child: FakeChild; session: StreamJsonSession; events: string[] } {
  const child = new FakeChild();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp', env: {} }, () => child as StreamChild);
  const events: string[] = [];
  s.on('done', () => events.push('done'));
  s.on('waiting', (reason: string) => events.push(`waiting:${reason}`));
  s.on('stalled', () => events.push('stalled'));
  s.start();
  return { child, session: s, events };
}

const OSC_TITLE = '\x1b]2;✅ a tab title\x07';

test('a done survives a hook writing a terminal escape onto the front of the result', () => {
  const { child, session: s, events } = session();
  s.send('go');
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Nothing further to do. @@LUBBDUBB_DONE@@' }] },
  });
  child.raw(OSC_TITLE);
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.equal(s.status, 'done', 'the turn end is read through the noise');
  assert.deepEqual(events, ['done']);
  assert.ok(child.stdinEnded, 'and the session is torn down rather than left live');
});

test('a waiting sentinel survives the same glued prefix', () => {
  const { child, session: s, events } = session();
  s.send('go');
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '@@LUBBDUBB_WAITING:Which auth provider?@@' }] },
  });
  child.raw(OSC_TITLE);
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.deepEqual(events, ['waiting:Which auth provider?']);
});

test('an unannounced stop is still reported through the noise, not swallowed', () => {
  const { child, session: s, events } = session();
  s.send('go');
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hmm.' }] } });
  child.raw(OSC_TITLE);
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.deepEqual(events, ['stalled'], 'losing the result would lose this too');
});

test('a whole JSON object glued to the front does not hide the event behind it', () => {
  const { child, session: s, events } = session();
  s.send('go');
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done here @@LUBBDUBB_DONE@@' }] },
  });
  child.raw('{"terminalSequence":"x"}');
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.deepEqual(events, ['done']);
});

test('a line carrying no event at all is still ignored', () => {
  const { child, session: s, events } = session();
  s.send('go');
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  child.raw('npm warn deprecated something@1.0.0\n');
  child.raw('a stray { brace that opens nothing\n');
  assert.deepEqual(events, [], 'noise is not an event, and must not be invented into one');
  assert.equal(s.status, 'running');
});
