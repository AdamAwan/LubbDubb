import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildIntegrations } from '../src/integrations/registry.js';
import { loadConfig } from '../src/config.js';
import type { IntegrationSelection } from '../src/integrations/integration.js';

const FIXED = () => '2026-01-01T00:00:00.000Z';

function selection(over: Partial<IntegrationSelection>): IntegrationSelection {
  return { sourceControl: 'fake', issues: 'fake', backlog: 'fake', calendar: 'fake', ...over };
}

const TARGET = { organization: 'org', project: 'proj', repository: 'repo' };

test('loadConfig carries an azureDevOps block (org/project/repo/filters) from overrides', () => {
  const config = loadConfig({
    azureDevOps: { ...TARGET, filters: { prAuthor: 'bot@acme.com', workItemTag: 'agent-ready' } },
  });
  assert.equal(config.azureDevOps?.organization, 'org');
  assert.equal(config.azureDevOps?.project, 'proj');
  assert.equal(config.azureDevOps?.repository, 'repo');
  assert.equal(config.azureDevOps?.filters?.prAuthor, 'bot@acme.com');
  assert.equal(config.azureDevOps?.filters?.workItemTag, 'agent-ready');
});

test('registry builds real azure providers when selected with a target', () => {
  const store = new Store(':memory:');
  const config = loadConfig({ azureDevOps: TARGET });
  const integrations = buildIntegrations(selection({ sourceControl: 'azure', issues: 'azure' }), {
    store,
    config,
    now: FIXED,
  });
  const byCap = Object.fromEntries(integrations.map((i) => [i.capability, i.id]));
  assert.equal(byCap.sourceControl, 'sourceControl:azure');
  assert.equal(byCap.issues, 'issues:azure');
  store.close();
});

test('registry throws a clear error when azure is selected without a target', () => {
  const store = new Store(':memory:');
  const config = loadConfig(); // no azureDevOps block
  assert.throws(
    () => buildIntegrations(selection({ sourceControl: 'azure' }), { store, config, now: FIXED }),
    /azureDevOps.*(organization|project|repository)/is,
  );
  store.close();
});

test('azure appears in the valid-providers list for an unknown provider error', () => {
  const store = new Store(':memory:');
  assert.throws(
    () => buildIntegrations(selection({ sourceControl: 'nope' }), { store, config: loadConfig(), now: FIXED }),
    /Valid providers:.*azure/s,
  );
  store.close();
});
