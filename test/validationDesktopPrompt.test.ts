import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopPrompt } from '../web/src/components/ValidationSection.js';
import { desktopDeepLink, discussPrompt } from '../web/src/cockpit/desktopLink.js';

/**
 * The cockpit's two affordances for the desktop channel: run a check there, and
 * discuss a plan there.
 *
 * Both hand off work the cockpit cannot start itself — a browser has no reach into
 * the socket the operator's own Claude Code connects over. So the surfaces' whole
 * job is to open that client on the right repository with the right command, and
 * the ways that goes silently wrong are asserted here.
 *
 * → docs/spec/20-validation.md#the-desktop-channel, docs/spec/08-planning.md
 */

const SOURCE = readFileSync(new URL('../web/src/components/ValidationSection.tsx', import.meta.url), 'utf8');

test('the prompt addresses a check by its goal and its stored letter', () => {
  assert.equal(desktopPrompt(249, 'A'), '/lubbdubb 249:A');
  // The letter is the handle that survives an amendment, which is why it is what
  // the skill takes. Built from a row's position instead, this would go on
  // rendering correctly and address a different check after the next amendment —
  // the failure the stored letter exists to prevent, one layer up.
  assert.equal(desktopPrompt(249, 'D'), '/lubbdubb 249:D');
});

test('a discussion addresses a plan by its goal number', () => {
  // Never the plan's id: that is a harness row, and `plan_read` / `plan_amend`
  // resolve a plan by the goal it hangs off. The number is also the only half of
  // the pair the operator is looking at.
  assert.equal(discussPrompt(284), '/lubbdubb discuss 284');
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
  // not installed answers nothing at all — so an operator has to be able to read
  // the command and type it themselves. It is in the title, from the same string
  // the link carries.
  assert.ok(
    /title=\{`Opens your own Claude Code with "\$\{promptText\}"/.test(SOURCE),
    'the control names the command it sends in its title',
  );
  assert.ok(SOURCE.includes('desktopDeepLink(desktopFolder, promptText)'), 'and links to that same string');
});

test('the control sits with the hand-over, on an unrun check', () => {
  // Beside "Hand to the fleet" and inside the same `state === 'unrun'` arm: both
  // say *who runs this check*, and neither is a reading. Offered on every unrun
  // check rather than only a nominated one, the hand-over's rule — an operator
  // who knows their own machine does not need the planner's permission.
  const unrun = SOURCE.slice(SOURCE.indexOf("check.state === 'unrun' ?"), SOURCE.indexOf('Back to unrun'));
  assert.ok(unrun.includes('Run it in Claude Code'), 'the desktop hand-off is drawn on an unrun check');
  assert.ok(unrun.includes('Hand to the fleet'), 'beside the fleet hand-over');
});
