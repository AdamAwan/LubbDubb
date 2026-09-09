import assert from 'node:assert/strict';
import test from 'node:test';
import { RestAzureDevOpsApi } from '../src/integrations/azure/restAzureDevOpsApi.js';

interface Exchange {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function apiOn(tags: () => string, onPatch: (value: string) => void) {
  const seen: Exchange[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    seen.push({ url: String(url), method, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body });
    if (method === 'PATCH') {
      const ops = JSON.parse(body ?? '[]') as Array<{ value?: string }>;
      onPatch(ops[0]?.value ?? '');
    }
    return new Response(JSON.stringify({ id: 7, fields: { 'System.Tags': tags() } }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: 'W/"tags"' },
    });
  };
  const api = new RestAzureDevOpsApi(
    'org',
    'proj',
    'repo',
    {
      async header() {
        return 'Bearer t';
      },
    },
    fetchImpl,
  );
  return { api, seen };
}

test('dropping a watch tag matches the tag Azure stored, whatever its casing', async () => {
  let stored = 'LubbDubb-Watch; keep';
  const { api } = apiOn(
    () => stored,
    (value) => {
      stored = value;
    },
  );

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  assert.equal(stored, 'keep');
});

test('a tag write reads the item fresh rather than through the ETag cache', async () => {
  let stored = 'lubbdubb-watch';
  const { api, seen } = apiOn(
    () => stored,
    (value) => {
      stored = value;
    },
  );

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);
  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  const reads = seen.filter((e) => e.method === 'GET');
  assert.equal(reads.length, 2);
  assert.equal(reads[1]?.headers['If-None-Match'], undefined, 'the read-modify-write must not be validated');
  assert.equal(stored, '');
});

test('a tag write that Azure accepts but does not apply is an error, not a silent no-op', async () => {
  const { api } = apiOn(
    () => 'lubbdubb-watch',
    () => {},
  );

  await assert.rejects(
    () => api.setWorkItemTag(7, 'lubbdubb-watch', false),
    /was not removed/,
    'the operator must hear that the tag survived',
  );
});

test('clearing the last tag removes the field rather than writing it empty', async () => {
  let stored = 'lubbdubb-watch';
  const { api, seen } = apiOn(
    () => stored,
    () => {
      stored = '';
    },
  );

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  const patches = seen.filter((e) => e.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]?.body ?? '[]'), [{ op: 'remove', path: '/fields/System.Tags' }]);
});

test('a tag already in the state asked for is not written again', async () => {
  const { api, seen } = apiOn(
    () => 'LubbDubb-Watch; keep',
    () => assert.fail('an item already carrying the tag must not be re-tagged'),
  );

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);
  await api.setWorkItemTag(7, 'gone', false);

  assert.equal(seen.filter((e) => e.method === 'PATCH').length, 0);
});
