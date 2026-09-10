import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  askPrompt,
  checkPrompt,
  desktopDeepLink,
  discussPrompt,
  localRunPrompt,
  questionPrompt,
} from '../web/src/cockpit/desktopLink.js';
import { repoPath, repoText } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { DesktopLink } = await import('../web/src/components/DesktopLink.js');
const { ControlBar, ControlGroup } = await import('../web/src/components/controls.js');

const SOURCE = repoText('web/src/components/ValidationSection.tsx');
const GOAL_PAGE = repoText('web/src/console/GoalPage.tsx');
const TOP_BAR = repoText('web/src/console/TopBar.tsx');

const desktop = (props: { folder: string; prompt: string; explain: string; ready?: string }): string =>
  renderToStaticMarkup(createElement(DesktopLink, props));

test('the prompt addresses a check by its goal and its stored letter', () => {
  assert.equal(checkPrompt(249, 'A'), '/lubbdubb 249:A');
  assert.equal(checkPrompt(249, 'D'), '/lubbdubb 249:D');
});

test('a discussion addresses a plan by its goal number', () => {
  assert.equal(discussPrompt(284), '/lubbdubb discuss 284');
});

test('running it locally addresses the goal by number, and is offered on every goal', () => {
  assert.equal(localRunPrompt(284), '/lubbdubb run 284');

  assert.ok(
    /<DesktopLink[^>]*?prompt=\{localRunPrompt\(issue\.number\)\}/s.test(GOAL_PAGE),
    'the goal page links to the run prompt on its own number',
  );
});

test('the deep link opens Claude Code on the goal’s own checkout', () => {
  const link = desktopDeepLink('/home/you/code/shop', '/lubbdubb discuss 284');
  assert.ok(link.startsWith('claude://code/new?'), link);
  const query = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  assert.equal(query.get('q'), '/lubbdubb discuss 284');
  assert.equal(query.get('folder'), '/home/you/code/shop');
});

test('a Windows checkout survives the encoding', () => {
  const link = desktopDeepLink('C:\\Users\\you\\Code\\LubbDubb', '/lubbdubb 249:A');
  const query = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  assert.equal(query.get('folder'), 'C:\\Users\\you\\Code\\LubbDubb');
  assert.equal(query.get('q'), '/lubbdubb 249:A');
});

test('the command is readable, not only clickable', () => {
  const html = desktop({ folder: '/home/you/shop', prompt: checkPrompt(249, 'A'), explain: 'so it runs there.' });
  assert.match(
    html,
    /title="Opens your own Claude Code with &quot;\/lubbdubb 249:A&quot; ready to send, so it runs there\."/,
  );
  assert.match(
    html,
    /href="claude:\/\/code\/new\?q=%2Flubbdubb\+249%3AA&amp;folder=%2Fhome%2Fyou%2Fshop"/,
    'the title names the string the link carries',
  );

  assert.match(html, /^<a /);
  assert.doesNotMatch(html, /target=/);
});

test('a prompt the operator still has to finish says so', () => {
  const html = desktop({
    folder: '/home/you/shop',
    prompt: askPrompt(284),
    explain: 'answered from the record.',
    ready: 'ready for your question',
  });
  assert.match(html, /&quot;\/lubbdubb ask 284&quot; ready for your question, answered from the record\./);
  assert.match(html, /q=%2Flubbdubb\+ask\+284\+&/);
});

test('nothing outside DesktopLink builds a link into Claude Code', () => {
  const root = repoPath('web/src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  const offenders = walk(root)
    .filter((file) => /\.tsx$/.test(file))
    .filter((file) => !file.endsWith('DesktopLink.tsx'))
    .filter((file) => /desktopDeepLink|claude:\/\//.test(readFileSync(file, 'utf8')));

  assert.deepEqual(offenders, [], 'draw a desktop hand-off through <DesktopLink>');
});

test('the control sits with the hand-over, on a check nobody has answered yet', () => {
  // `captured` is in the same arm on purpose: the screen is on the row and the only thing left is a
  // person's reading, which is exactly what the hand-offs beside it are for.
  const anchor = "check.state === 'unrun' || check.state === 'captured' ?";
  const unrun = SOURCE.slice(SOURCE.indexOf(anchor), SOURCE.indexOf('Back to unrun'));
  assert.ok(SOURCE.includes(anchor), 'the four readings are offered on an unrun check and on a captured one');
  assert.ok(unrun.includes('<DesktopLink'), 'the desktop hand-off is drawn there');
  assert.ok(unrun.includes('Hand to the fleet'), 'beside the fleet hand-over');
});

test('the bar’s question control prefills the skill and nothing else', () => {
  assert.equal(questionPrompt(), '/lubbdubb ');

  const html = desktop({
    folder: '/home/you/shop',
    prompt: questionPrompt(),
    explain: 'which answers it.',
    ready: 'waiting for your question',
  });
  assert.match(html, /title="Opens your own Claude Code with &quot;\/lubbdubb&quot; waiting for your question, /);

  assert.ok(
    /<DesktopLink[\s\S]*?prompt=\{questionPrompt\(\)\}/.test(TOP_BAR),
    'the top bar links to the question prompt',
  );
  assert.ok(
    /<DesktopLink[\s\S]*?folder=\{view\.state\.config\.desktopFolder\}/.test(TOP_BAR),
    'and opens it on the repository the fleet works on',
  );
});

test('a hand-off inside a control row wears the control kit, not the button', () => {
  const props = { folder: '/home/you/shop', prompt: askPrompt(284), explain: 'which answers it.' };

  const alone = desktop(props);
  assert.match(alone, /class="btn btn ghost small"/, 'on its own it is the shared button');

  const inRow = renderToStaticMarkup(
    createElement(
      ControlBar,
      null,
      createElement(ControlGroup, {
        caption: 'Leave this page',
        icon: 'ticket',
        children: createElement(DesktopLink, props),
      }),
    ),
  );
  assert.match(inRow, /<a class="cn-tgl"/, 'in a control row it wears the control class');
  assert.ok(!inRow.includes('class="btn'), 'and never both kits at once');
});
