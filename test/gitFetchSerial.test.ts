import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSerial } from '../src/git/serialQueue.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('work on one key never overlaps', async () => {
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (n: number) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await tick(5);
    order.push(n);
    running -= 1;
  };
  await Promise.all([runSerial('a', job(1)), runSerial('a', job(2)), runSerial('a', job(3))]);
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('a failure rejects its own caller and does not stall the queue', async () => {
  const failing = runSerial('b', () => Promise.reject(new Error('boom')));
  const after = runSerial('b', () => Promise.resolve('ran'));
  await assert.rejects(failing, /boom/);
  assert.equal(await after, 'ran');
});

test('different keys run concurrently', async () => {
  let running = 0;
  let peak = 0;
  const job = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await tick(5);
    running -= 1;
  };
  await Promise.all([runSerial('c', job), runSerial('d', job)]);
  assert.equal(peak, 2);
});
