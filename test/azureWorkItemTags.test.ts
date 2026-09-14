import assert from 'node:assert/strict';
import test from 'node:test';
import { RestAzureDevOpsApi } from '../src/integrations/azure/restAzureDevOpsApi.js';
import { parseTags } from '../src/integrations/azure/workItems.js';

interface Exchange {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface PatchOp {
  op: string;
  path: string;
  value?: string;
}

function merge(stored: string, value: string): string {
  const kept = parseTags(stored);
  for (const tag of parseTags(value)) {
    if (!kept.some((t) => t.localeCompare(tag, undefined, { sensitivity: 'accent' }) === 0)) kept.push(tag);
  }
  return kept.join('; ');
}

function apiOn(initial: string, opts: { applies?: boolean } = {}) {
  const seen: Exchange[] = [];
  const state = { tags: initial };
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    seen.push({ url: String(url), method, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body });
    if (method === 'PATCH') {
      const ops = (JSON.parse(body ?? '[]') as PatchOp[]).filter((op) => op.path === '/fields/System.Tags');
      if (ops.length > 1) {
        return new Response(
          JSON.stringify({
            message:
              'VS403691: Update to work item 7 had two or more updates for field with reference name ' +
              "'System.Tags'. A field cannot be updated more than once in the same update.",
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (opts.applies !== false) {
        for (const op of ops) {
          if (op.op === 'remove') state.tags = '';
          else if (op.op === 'replace') state.tags = op.value ?? '';
          else state.tags = merge(state.tags, op.value ?? '');
        }
      }
    }
    return new Response(JSON.stringify({ id: 7, fields: { 'System.Tags': state.tags } }), {
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
  return { api, seen, state };
}

test('dropping a watch tag matches the tag Azure stored, whatever its casing', async () => {
  const { api, state } = apiOn('LubbDubb-Watch; keep');

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  assert.equal(state.tags, 'keep');
});

test('dropping a tag from an item that carries others leaves the others and drops that one', async () => {
  const { api, state } = apiOn('model-standard; lubbdubb-watch; Customer; Statement Matching; zendesk');

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  assert.equal(state.tags, 'model-standard; Customer; Statement Matching; zendesk');
});

test('a tag write reads the item fresh rather than through the ETag cache', async () => {
  const { api, seen, state } = apiOn('lubbdubb-watch');

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);
  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  const reads = seen.filter((e) => e.method === 'GET');
  assert.equal(reads.length, 2);
  assert.equal(reads[1]?.headers['If-None-Match'], undefined, 'the read-modify-write must not be validated');
  assert.equal(state.tags, '');
});

test('a tag write that Azure accepts but does not apply is an error, not a silent no-op', async () => {
  const { api } = apiOn('lubbdubb-watch', { applies: false });

  await assert.rejects(
    () => api.setWorkItemTag(7, 'lubbdubb-watch', false),
    /was not removed/,
    'the operator must hear that the tag survived',
  );
});

test('a removal replaces the field with the tags it keeps, in a single op', async () => {
  const { api, seen, state } = apiOn('lubbdubb-watch; keep');

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  const patches = seen.filter((e) => e.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]?.body ?? '[]'), [
    { op: 'replace', path: '/fields/System.Tags', value: 'keep' },
  ]);
  assert.equal(state.tags, 'keep');
});

test('clearing the last tag removes the field rather than writing it empty', async () => {
  const { api, seen, state } = apiOn('lubbdubb-watch');

  await api.setWorkItemTag(7, 'lubbdubb-watch', false);

  const patches = seen.filter((e) => e.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]?.body ?? '[]'), [{ op: 'remove', path: '/fields/System.Tags' }]);
  assert.equal(state.tags, '');
});

test('adding a tag to an item that carries none is an add', async () => {
  const { api, seen, state } = apiOn('');

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);

  const patches = seen.filter((e) => e.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]?.body ?? '[]'), [
    { op: 'add', path: '/fields/System.Tags', value: 'lubbdubb-watch' },
  ]);
  assert.equal(state.tags, 'lubbdubb-watch');
});

test('adding a tag beside others writes the whole list in one op', async () => {
  const { api, seen, state } = apiOn('keep; other');

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);

  const patches = seen.filter((e) => e.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]?.body ?? '[]'), [
    { op: 'replace', path: '/fields/System.Tags', value: 'keep; other; lubbdubb-watch' },
  ]);
  assert.equal(state.tags, 'keep; other; lubbdubb-watch');
});

test('no tag write names System.Tags twice, which Azure refuses with VS403691', async () => {
  for (const [initial, tag, present] of [
    ['lubbdubb-watch; keep', 'lubbdubb-watch', false],
    ['lubbdubb-watch', 'lubbdubb-watch', false],
    ['', 'lubbdubb-watch', true],
    ['keep', 'lubbdubb-watch', true],
  ] as const) {
    const { api, seen } = apiOn(initial);
    await api.setWorkItemTag(7, tag, present);
    for (const patch of seen.filter((e) => e.method === 'PATCH')) {
      const ops = (JSON.parse(patch.body ?? '[]') as PatchOp[]).filter((o) => o.path === '/fields/System.Tags');
      assert.equal(ops.length, 1, `one op per write, saw ${ops.length} for ${initial}`);
    }
  }
});

test('a tag already in the state asked for is not written again', async () => {
  const { api, seen } = apiOn('LubbDubb-Watch; keep');

  await api.setWorkItemTag(7, 'lubbdubb-watch', true);
  await api.setWorkItemTag(7, 'gone', false);

  assert.equal(seen.filter((e) => e.method === 'PATCH').length, 0);
});
