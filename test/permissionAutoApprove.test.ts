import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionDesk } from '../src/agents/permissionDesk.js';
import type { EscalationInbox } from '../src/escalation/escalationInbox.js';
import type { Agent, Task } from '../src/types.js';

const AGENT = { id: 'agent_1' } as Agent;

function task(permissionAutoApprove: boolean | null): Task {
  return { id: 'task_1', title: 'ship it', originRef: 'issue:1', permissionAutoApprove } as Task;
}

function desk(): { desk: PermissionDesk; created: string[] } {
  const created: string[] = [];
  const escalations = {
    create(input: { prompt: string }) {
      created.push(input.prompt);
      return { id: `esc_${created.length}` };
    },
  } as unknown as EscalationInbox;
  return { desk: new PermissionDesk(escalations), created };
}

test('a task on an auto-approving profile is allowed by the harness, with no escalation raised', async () => {
  const { desk: d, created } = desk();
  const verdict = await d.request(AGENT, task(true), 'Bash', { command: 'npm test' });
  assert.deepEqual(verdict, { behavior: 'allow', updatedInput: { command: 'npm test' } });
  assert.deepEqual(created, [], 'nobody is asked');
});

test('every other task still blocks on the operator', async () => {
  for (const auto of [false, null]) {
    const { desk: d, created } = desk();
    let settled = false;
    void d.request(AGENT, task(auto), 'Bash', { command: 'npm test' }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(created.length, 1, `autoApprove ${auto} raises an escalation`);
    assert.equal(settled, false, 'and the agent waits on it');
  }
});
