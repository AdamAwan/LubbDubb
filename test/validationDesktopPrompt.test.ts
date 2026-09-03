import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// The classic runtime, as `console.test.ts` sets it up and for its reason.
(globalThis as { React?: typeof React }).React = React;

const { DesktopLink } = await import('../web/src/components/DesktopLink.js');

/**
 * The cockpit's three affordances for the desktop channel: run a check there,
 * discuss a plan there, and get the application up there.
 *
 * Both hand off work the cockpit cannot start itself — a browser has no reach into
 * the socket the operator's own Claude Code connects over. So the surfaces' whole
 * job is to open that client on the right repository with the right command, and
 * the ways that goes silently wrong are asserted here.
 *
 * → docs/spec/20-validation.md#the-desktop-channel, docs/spec/08-planning.md
 */

const SOURCE = readFileSync(new URL('../web/src/components/ValidationSection.tsx', import.meta.url), 'utf8');
const GOAL_PAGE = readFileSync(new URL('../web/src/console/GoalPage.tsx', import.meta.url), 'utf8');
const TOP_BAR = readFileSync(new URL('../web/src/console/TopBar.tsx', import.meta.url), 'utf8');

const desktop = (props: { folder: string; prompt: string; explain: string; ready?: string }): string =>
  renderToStaticMarkup(createElement(DesktopLink, { ...props, className: 'btn', children: 'Go' }));

test('the prompt addresses a check by its goal and its stored letter', () => {
  assert.equal(checkPrompt(249, 'A'), '/lubbdubb 249:A');
  // The letter is the handle that survives an amendment, which is why it is what
  // the skill takes. Built from a row's position instead, this would go on
  // rendering correctly and address a different check after the next amendment —
  // the failure the stored letter exists to prevent, one layer up.
  assert.equal(checkPrompt(249, 'D'), '/lubbdubb 249:D');
});

test('a discussion addresses a plan by its goal number', () => {
  // Never the plan's id: that is a harness row, and `plan_read` / `plan_amend`
  // resolve a plan by the goal it hangs off. The number is also the only half of
  // the pair the operator is looking at.
  assert.equal(discussPrompt(284), '/lubbdubb discuss 284');
});

test('running it locally addresses the goal by number, and is offered on every goal', () => {
  // The goal's number for the other two prompts' reason: it is what `local_run`
  // resolves the parts and their branches by, and what the operator is looking at.
  assert.equal(localRunPrompt(284), '/lubbdubb run 284');

  // Drawn with no condition in front of it. The `local-run` prompt always has a
  // body — the default says "work it out from the repository" — so there is no
  // configured state a button could fall out of step with, and a control offered
  // only where somebody had already configured one would be a dead end found by
  // walking into it. That argument is why the whole channel is unconditional.
  assert.ok(
    /<DesktopLink[^>]*?prompt=\{localRunPrompt\(issue\.number\)\}/s.test(GOAL_PAGE),
    'the goal page links to the run prompt on its own number',
  );
});

test('the deep link opens Claude Code on the goal’s own checkout', () => {
  const link = desktopDeepLink('/home/you/code/shop', '/lubbdubb discuss 284');
  // `code`, not `claude.ai`: the client routes the two differently, and only this
  // host lands somewhere with the repository, the skill and the MCP registration.
  assert.ok(link.startsWith('claude://code/new?'), link);
  const query = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  assert.equal(query.get('q'), '/lubbdubb discuss 284');
  // Without the folder the session opens wherever that client was last, which is
  // a Claude that cannot read the plan it was sent to argue about.
  assert.equal(query.get('folder'), '/home/you/code/shop');
});

test('a Windows checkout survives the encoding', () => {
  // The path a real deployment on this platform carries. Backslashes and the
  // colon go through `URLSearchParams`, so the only way this breaks is somebody
  // hand-rolling the query string later.
  const link = desktopDeepLink('C:\\Users\\you\\Code\\LubbDubb', '/lubbdubb 249:A');
  const query = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  assert.equal(query.get('folder'), 'C:\\Users\\you\\Code\\LubbDubb');
  assert.equal(query.get('q'), '/lubbdubb 249:A');
});

test('the command is readable, not only clickable', () => {
  // A deep link reaches only the machine the browser is on, and a client that is
  // not installed answers **nothing at all** — no error, no tab, no window. So an
  // operator reading the cockpit from another desk has to be able to read the
  // command and type it themselves, and the title is the only place left to put
  // it. `DesktopLink` composes that clause rather than trusting five call sites to
  // remember it: two of them had already forgotten, and a forgetting is only ever
  // reported by the person it happened to.
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

  // A deep link is a destination, so it is an anchor — never a button with a
  // click handler. `claude://` is handed to the OS handler rather than navigated
  // to, so a `target="_blank"` on it is a blank tab left behind.
  assert.match(html, /^<a /);
  assert.doesNotMatch(html, /target=/);
});

/**
 * **Ask** is the one command that is not complete when it lands: `q` fills the
 * composer with the goal already settled and stops, because the operator has not
 * said what they are asking yet. Guessing a question would be a control that asked
 * something else on the occasions it was wrong, and there is no reading of a click
 * that says which question it was. The title has to say so, or it promises a send
 * that never comes.
 */
test('a prompt the operator still has to finish says so', () => {
  const html = desktop({
    folder: '/home/you/shop',
    prompt: askPrompt(284),
    explain: 'answered from the record.',
    ready: 'ready for your question',
  });
  assert.match(html, /&quot;\/lubbdubb ask 284&quot; ready for your question, answered from the record\./);
  // The trailing space is what leaves the cursor after the number, and it belongs
  // in the link rather than in the sentence quoting it.
  assert.match(html, /q=%2Flubbdubb\+ask\+284\+&/);
});

/**
 * The guard that keeps the above true of every control rather than of one. The URL
 * was already written once; the *control* was written five times, and the titles
 * had drifted — the plan sheet's two **Discuss…** anchors said what the session
 * would do and never what command it would arrive with. A sixth site hand-rolling
 * its own anchor would compile, render and open the right client, and simply be
 * silent for the operator who has no client to answer it.
 */
test('nothing outside DesktopLink builds a link into Claude Code', () => {
  const root = fileURLToPath(new URL('../web/src/', import.meta.url));
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

test('the control sits with the hand-over, on an unrun check', () => {
  // Beside "Hand to the fleet" and inside the same `state === 'unrun'` arm: both
  // say *who runs this check*, and neither is a reading. Offered on every unrun
  // check rather than only a nominated one, the hand-over's rule — an operator
  // who knows their own machine does not need the planner's permission.
  const unrun = SOURCE.slice(SOURCE.indexOf("check.state === 'unrun' ?"), SOURCE.indexOf('Back to unrun'));
  assert.ok(unrun.includes('Run it in Claude Code'), 'the desktop hand-off is drawn on an unrun check');
  assert.ok(unrun.includes('<DesktopLink'), 'and it is drawn through the one control that opens that client');
  assert.ok(unrun.includes('Hand to the fleet'), 'beside the fleet hand-over');
});

/**
 * The bar's own hand-off, which is the only one drawn beside nothing.
 *
 * Every other deep link is next to the goal, plan or check it addresses. This one
 * is next to the wordmark, because the question it exists for — *why is this not
 * being done?* — is asked before the operator has decided which goal it is about,
 * and was until now asked of a person or not at all.
 */
test('the bar’s question control prefills the skill and nothing else', () => {
  // No argument: the bar knows of no goal, and the skill routes on the words the
  // operator types after it — a number in them is the goal job, none is the fleet
  // one. A subject guessed here would be a session opened on a different question.
  assert.equal(questionPrompt(), '/lubbdubb ');

  // Unsent, like Ask and for one step further along the same reason: there is not
  // even a subject yet, so `q` fills the composer and stops.
  const html = desktop({
    folder: '/home/you/shop',
    prompt: questionPrompt(),
    explain: 'which answers it.',
    ready: 'waiting for your question',
  });
  assert.match(html, /title="Opens your own Claude Code with &quot;\/lubbdubb&quot; waiting for your question, /);

  // Drawn through `DesktopLink` on the checkout the fleet works, with no condition
  // in front of it: the link reaches only the machine the browser is on, and the
  // component is what leaves the command readable for the operator it cannot reach.
  assert.ok(
    /<DesktopLink[\s\S]*?prompt=\{questionPrompt\(\)\}/.test(TOP_BAR),
    'the top bar links to the question prompt',
  );
  assert.ok(
    /<DesktopLink[\s\S]*?folder=\{view\.state\.config\.desktopFolder\}/.test(TOP_BAR),
    'and opens it on the repository the fleet works on',
  );
});
