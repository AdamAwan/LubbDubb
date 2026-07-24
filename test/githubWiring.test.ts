import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildIntegrations } from '../src/integrations/registry.js';
import { loadConfig } from '../src/config.js';
import type { IntegrationSelection } from '../src/integrations/integration.js';

const FIXED = () => '2026-01-01T00:00:00.000Z';

/** Run `fn` with GITHUB_TOKEN set to `token` (or unset when null), then restore it. */
function withToken(token: string | null, fn: () => void): void {
  const prev = process.env.GITHUB_TOKEN;
  if (token === null) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
}

function selection(over: Partial<IntegrationSelection>): IntegrationSelection {
  return { sourceControl: 'fake', issues: 'fake', backlog: 'fake', calendar: 'fake', ...over };
}

test('loadConfig carries a github block (owner/repo/filters) from overrides', () => {
  const config = loadConfig({
    github: { owner: 'acme', repo: 'app', filters: { prAuthor: 'bot' } },
  });
  assert.equal(config.github?.owner, 'acme');
  assert.equal(config.github?.repo, 'app');
  assert.equal(config.github?.filters?.prAuthor, 'bot');
});

test('registry builds real github providers when selected with a token + owner/repo', () => {
  withToken('ghp_test', () => {
    const store = new Store(':memory:');
    const config = loadConfig({ github: { owner: 'o', repo: 'r' } });
    const integrations = buildIntegrations(selection({ sourceControl: 'github', issues: 'github' }), {
      store,
      config,
      now: FIXED,
    });
    const byCap = Object.fromEntries(integrations.map((i) => [i.capability, i.id]));
    assert.equal(byCap.sourceControl, 'sourceControl:github');
    assert.equal(byCap.issues, 'issues:github');
    store.close();
  });
});

test('registry throws a clear error when github is selected without GITHUB_TOKEN', () => {
  withToken(null, () => {
    const store = new Store(':memory:');
    const config = loadConfig({ github: { owner: 'o', repo: 'r' } });
    assert.throws(
      () => buildIntegrations(selection({ sourceControl: 'github' }), { store, config, now: FIXED }),
      /GITHUB_TOKEN/,
    );
    store.close();
  });
});

test('registry throws a clear error when github is selected without owner/repo config', () => {
  withToken('ghp_test', () => {
    const store = new Store(':memory:');
    const config = loadConfig(); // no github block
    assert.throws(
      () => buildIntegrations(selection({ issues: 'github' }), { store, config, now: FIXED }),
      /github.*(owner|repo)/is,
    );
    store.close();
  });
});
