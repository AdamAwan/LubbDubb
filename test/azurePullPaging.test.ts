import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestAzureDevOpsApi } from '../src/integrations/azure/restAzureDevOpsApi.js';

test('the azure closed-PR read pages past the first hundred', async () => {
  const pulls = Array.from({ length: 150 }, (_, i) => ({
    pullRequestId: i + 1,
    title: `PR ${i + 1}`,
    sourceRefName: `refs/heads/feat/${i + 1}`,
    targetRefName: 'refs/heads/main',
    status: 'completed',
    closedDate: '2026-07-25T11:00:00.000Z',
  }));
  const skips: number[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const u = new URL(String(url));
    const skip = Number(u.searchParams.get('$skip') ?? '0');
    const top = Number(u.searchParams.get('$top'));
    skips.push(skip);
    return new Response(JSON.stringify({ value: pulls.slice(skip, skip + top) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = new RestAzureDevOpsApi('org', 'proj', 'repo', { header: async () => 'Bearer t' }, fetchImpl);

  const closed = await api.listRecentlyClosedPullRequests('2026-07-25T09:00:00.000Z');

  assert.equal(closed.length, 150);
  assert.deepEqual(skips, [0, 100]);
});

test('a pull request the list shifts onto two pages is read once', async () => {
  const pull = (id: number) => ({
    pullRequestId: id,
    title: `PR ${id}`,
    sourceRefName: `refs/heads/feat/${id}`,
    targetRefName: 'refs/heads/main',
  });
  const pages = [Array.from({ length: 100 }, (_, i) => pull(i + 1)), [pull(100), pull(101)]];
  let call = 0;
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ value: pages[call++] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const api = new RestAzureDevOpsApi('org', 'proj', 'repo', { header: async () => 'Bearer t' }, fetchImpl);

  const active = await api.listActivePullRequests();

  assert.deepEqual(
    active.map((p) => p.pullRequestId),
    Array.from({ length: 101 }, (_, i) => i + 1),
  );
});
