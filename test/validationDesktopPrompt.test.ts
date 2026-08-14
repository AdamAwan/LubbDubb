import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopPrompt } from '../web/src/components/ValidationSection.js';

/**
 * The cockpit's one affordance for the desktop channel.
 *
 * A desktop session is the only runner of a validation check the cockpit cannot
 * start: the claim is taken from the operator's own Claude Code, over a socket a
 * browser has no reach into. So the surface's whole job is to hand over the line
 * that *does* start one, and the two ways that goes silently wrong are asserted
 * here.
 *
 * → docs/spec/20-validation.md#the-desktop-channel
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

test('the command is readable, not only copyable', () => {
  // A clipboard write can be refused — an insecure context, a denied permission —
  // and a command that lived only in the click handler would leave an operator
  // with a button that did nothing and nothing to type instead. It is in the
  // title too, from the same string.
  const title = /title=\{`Copies "\$\{promptText\}"/.test(SOURCE);
  assert.ok(title, 'the copy button names the command it copies in its title');
  assert.ok(SOURCE.includes('navigator.clipboard.writeText(promptText)'), 'and copies that same string');
});

test('the control sits with the hand-over, on an unrun check', () => {
  // Beside "Hand to the fleet" and inside the same `state === 'unrun'` arm: both
  // say *who runs this check*, and neither is a reading. Offered on every unrun
  // check rather than only a nominated one, the hand-over's rule — an operator
  // who knows their own machine does not need the planner's permission.
  const unrun = SOURCE.slice(SOURCE.indexOf("check.state === 'unrun' ?"), SOURCE.indexOf('Back to unrun'));
  assert.ok(unrun.includes('Copy desktop prompt'), 'the copy control is drawn on an unrun check');
  assert.ok(unrun.includes('Hand to the fleet'), 'beside the fleet hand-over');
});
