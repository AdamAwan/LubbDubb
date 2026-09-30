import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { repoPath } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { BareButton, Button, buttonClass, expected, refusing } = await import('../web/src/components/button.js');

test('the base is written twice, so one rule dresses a button anywhere', () => {
  assert.equal(buttonClass({}), 'btn btn');
  assert.equal(buttonClass({ tone: 'secondary' }), 'btn btn');
  assert.equal(buttonClass({ tone: 'primary' }), 'btn btn primary');
});

test('one vocabulary, and it is the only one', () => {
  assert.equal(buttonClass({ tone: 'primary' }), 'btn btn primary');
  assert.equal(buttonClass({ tone: 'danger' }), 'btn btn danger');
  assert.equal(buttonClass({ ghost: true }), 'btn btn ghost');
  assert.equal(buttonClass({ size: 'small' }), 'btn btn small');
  assert.equal(buttonClass({ tone: 'secondary', ghost: true }), buttonClass({ ghost: true }));
});

test('a destructive button can also be a quiet one', () => {
  assert.equal(buttonClass({ tone: 'danger', ghost: true, size: 'small' }), 'btn btn danger ghost small');
});

test('shape rides beside the tone, never through it', () => {
  assert.equal(buttonClass({ ghost: true, className: 'work-root-head' }), 'btn btn ghost work-root-head');
});

/**
 * The verb a row expects and the one that refuses are *tones*, and the reason is
 * that they were classes with no rule behind them: `Done` drew identically to
 * `Decline` on every surface embedding the row. A tone resolves to a rule that is
 * already written, so the assertion is that each reaches the sheet.
 */
test('the verb a row expects is a tone, so it reaches a rule', () => {
  assert.deepEqual(expected({}), { tone: 'primary' });
  assert.deepEqual(refusing({}), { tone: 'danger' });
  assert.equal(buttonClass(expected({})), 'btn btn primary');
  assert.equal(buttonClass(refusing({})), 'btn btn danger');
  assert.notEqual(buttonClass(expected({})), buttonClass({}), 'the expected verb must not draw as the plain one');
});

test('the station composes on the caller, keeping the caller’s weight', () => {
  assert.deepEqual(expected({ ghost: true, size: 'small' }), { ghost: true, size: 'small', tone: 'primary' });
  assert.equal(buttonClass(expected({ ghost: true, size: 'small' })), 'btn btn primary ghost small');
  // The caller's own tone is what the station overrides, and only that.
  assert.deepEqual(expected({ tone: 'secondary' }), { tone: 'primary' });
});

test('a button is a button, never a form submit', () => {
  const html = renderToStaticMarkup(
    createElement(Button, { tone: 'primary', usage: 'plan.expand', children: 'Write' }),
  );
  assert.match(html, /type="button"/, 'a <button> in a <form> submits it unless it says otherwise');
  assert.match(html, /class="btn btn primary"/);
});

test('a button cannot be drawn without naming its usage event', () => {
  // @ts-expect-error every button names the event a press of it is
  createElement(Button, { children: 'Write' });
  // @ts-expect-error a `record` event is swept from its table, so the button only names it
  createElement(Button, { usage: 'plan.accept', children: 'Approve' });
  // @ts-expect-error a `view` is emitted from the place, never from the control that got there
  createElement(Button, { usage: 'plan.view', children: 'Open' });
  createElement(Button, { usage: { counted: 'plan.accept' }, children: 'Approve' });
  createElement(Button, { usage: { counted: 'plan.view' }, children: 'Open' });
});

test('a press logs a ui event, and only a ui event', () => {
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    posted.push(String(init?.body));
    return new Response('{}');
  }) as typeof fetch;
  try {
    let handled = 0;
    const press = (usage: Parameters<typeof BareButton>[0]['usage']) => {
      const element = BareButton({ usage, onClick: () => void handled++ });
      (element.props as { onClick: (event: unknown) => void }).onClick({});
    };
    // The batcher flushes at 500 queued events, so a full batch is what reaches the wire.
    for (let i = 0; i < 500; i++) press({ counted: 'plan.accept' });
    assert.equal(posted.length, 0, 'an event counted elsewhere is never logged from the press');
    for (let i = 0; i < 500; i++) press('pr-description.accept');
    assert.equal(posted.length, 1);
    assert.match(posted[0] ?? '', /"subject":"pr-description","verb":"accept"/);
    assert.equal(handled, 1000, 'the caller’s own handler still runs on every press');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no surface writes a button family of its own', () => {
  const root = repoPath('web/src');
  const owner = join(root, 'components', 'button.tsx');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
  const classes = (src: string): string[] =>
    [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) =>
      (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/[\s'"?:]+/),
    );
  for (const path of walk(root)) {
    if (path === owner) continue;
    for (const cls of classes(readFileSync(path, 'utf8'))) {
      assert.ok(
        !['btn', 'cn-btn', 'armed'].includes(cls),
        `${path} writes the class "${cls}"; buttons come from components/button.tsx`,
      );
    }
  }
});

/**
 * The row that settles an ask is the cockpit's most-embedded control group, and
 * its appearance has now been wrong three ways: the buttons drew identically to
 * each other, the group had no rule separating it from the prose above, and the
 * group's gap reached a wrapper rather than the buttons — `.btn-row` held one
 * `<span>` holding both, so `Done` and `Decline` touched.
 *
 * That last one is the shape this pins. A group whose only child is another
 * element is a group that styles nothing, and it renders as *almost* right,
 * which is why it survived two passes over the same row.
 */
test('a button group reaches the buttons, never a wrapper around them', async () => {
  const { HumanTaskActions } = await import('../web/src/components/HumanTaskActions.js');
  const task = {
    id: 't1',
    title: 'Re-point the staging watchers',
    detail: null,
    originRef: 'issue:390',
    partId: null,
    kind: 'bench',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    resolvedAt: null,
    dismissedAt: null,
  };
  const html = renderToStaticMarkup(
    createElement(HumanTaskActions, {
      task,
      look: { tone: 'secondary' },
      onDone: () => undefined,
      onDecline: () => undefined,
    } as never),
  );

  assert.match(html, /<div class="btn-row bar"><button/, 'the buttons are the group’s own children');
  assert.doesNotMatch(html, /<div class="btn-row[^"]*"><(?!button)/, 'nothing sits between the group and its buttons');
  // And the two verbs are told apart, which is what the tones are for.
  assert.match(html, /class="btn btn primary"[^>]*>Done</);
  assert.match(html, /class="btn btn">Decline</);
});
