import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { SvgButton } = await import('../web/src/components/button.js');
const { DesktopLink } = await import('../web/src/components/DesktopLink.js');
const { ExtLink } = await import('../web/src/components/util.js');

type Props = Record<string, unknown> & { onClick?: (event: unknown) => void };

/** Calls function components down to the first host element, the way a render would. */
function host(element: ReactElement): ReactElement<Props> {
  let at = element as ReactElement<Props>;
  while (typeof at.type === 'function') at = (at.type as (props: Props) => ReactElement<Props>)(at.props);
  return at;
}

/** A component with hooks is only callable inside a render, so it is called from one. */
function rendered(draw: () => ReactElement): ReactElement {
  let out: ReactElement | null = null;
  renderToStaticMarkup(
    createElement(() => {
      out = draw();
      return null;
    }),
  );
  assert.ok(out !== null);
  return out;
}

async function posting(run: () => void): Promise<string[]> {
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    posted.push(String(init?.body));
    return new Response('{}');
  }) as typeof fetch;
  try {
    run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return posted;
}

const desktop = { folder: '/work', prompt: '/lubbdubb discuss #12', explain: 'so it is talked through' };

test('a styled link cannot be drawn without naming its usage event', () => {
  // @ts-expect-error a deep link into Claude Code is a press, and names its event
  createElement(DesktopLink, desktop);
  // @ts-expect-error an external page worn as a button names its event
  createElement(ExtLink, { href: 'https://example.com', look: {}, children: 'Open' });
  // @ts-expect-error so does one worn as a control
  createElement(ExtLink, { href: 'https://example.com', control: true, children: 'Open' });
  // @ts-expect-error leaving the cockpit is a `ui` event, never one counted elsewhere
  createElement(DesktopLink, { ...desktop, usage: { counted: 'plan.accept' } });
  // @ts-expect-error and its verb is `open`
  createElement(DesktopLink, { ...desktop, usage: 'plan.expand' });
  createElement(DesktopLink, { ...desktop, usage: 'plan.open' });
  createElement(ExtLink, { href: 'https://example.com', look: {}, usage: 'ticket.open', children: 'Open' });
  // A plain link moves nowhere in the cockpit and names nothing.
  createElement(ExtLink, { href: 'https://example.com', children: '#12' });
});

test('a press of a deep link logs its event', async () => {
  const a = host(rendered(() => DesktopLink({ ...desktop, usage: 'plan.open' })));
  assert.equal(a.type, 'a');
  assert.match(String(a.props.className), /^btn btn ghost small$/);
  const posted = await posting(() => {
    for (let i = 0; i < 500; i++) a.props.onClick?.({});
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0] ?? '', /"subject":"plan","verb":"open"/);
});

test('a press of an external link worn as a control logs its event, and a plain one logs nothing', async () => {
  const control = host(
    ExtLink({ href: 'https://example.com', control: true, usage: 'ticket.open', children: 'Issue!' }),
  );
  const plain = host(ExtLink({ href: 'https://example.com', children: '#12' }));
  assert.equal(plain.props.onClick, undefined, 'a navigation link is counted by the place, never by the press');
  const posted = await posting(() => {
    for (let i = 0; i < 500; i++) control.props.onClick?.({});
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0] ?? '', /"subject":"ticket","verb":"open"/);
});

test('a plan node is a button in the svg, pressed by mouse or keyboard, and logs', async () => {
  let pressed = 0;
  const g = host(SvgButton({ usage: 'plan.expand', onPress: () => void pressed++, children: null }));
  assert.equal(g.type, 'g');
  assert.equal(g.props.role, 'button');
  const key = g.props.onKeyDown as (event: unknown) => void;
  const posted = await posting(() => {
    for (let i = 0; i < 250; i++) g.props.onClick?.({});
    for (let i = 0; i < 250; i++) key({ key: 'Enter', preventDefault: () => undefined });
    key({ key: 'a', preventDefault: () => undefined });
  });
  assert.equal(pressed, 500, 'a key that is not a press does nothing');
  assert.equal(posted.length, 1);
  assert.match(posted[0] ?? '', /"subject":"plan","verb":"expand"/);
});
