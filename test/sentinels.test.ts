import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSentinels, extractWaitingReason } from '../src/agents/sentinels.js';

test('stripSentinels removes a complete DONE sentinel', () => {
  assert.equal(stripSentinels('all finished\n@@LUBBDUBB_DONE@@'), 'all finished\n');
});

test('stripSentinels removes a complete WAITING sentinel with its reason', () => {
  assert.equal(stripSentinels('Which DB? @@LUBBDUBB_WAITING:Postgres or MySQL?@@'), 'Which DB? ');
});

test('stripSentinels leaves ordinary text untouched', () => {
  assert.equal(stripSentinels('nothing to strip here'), 'nothing to strip here');
});

test('stripSentinels reduces a sentinel-only string to empty', () => {
  assert.equal(stripSentinels('@@LUBBDUBB_WAITING:need input@@'), '');
});

test('extractWaitingReason pulls the reason out of a WAITING sentinel', () => {
  assert.equal(extractWaitingReason('please advise @@LUBBDUBB_WAITING:pick a name@@'), 'pick a name');
});

test('extractWaitingReason returns null when no sentinel is present', () => {
  assert.equal(extractWaitingReason('just running along @@LUBBDUBB_DONE@@'), null);
});
