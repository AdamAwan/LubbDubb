import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signOff } from '../src/sink/signOff.js';
import { CompositeConnector } from '../src/integrations/compositeConnector.js';
import type {
  Capability,
  Integration,
  IssueCommentCapable,
  IssueCreateCapable,
  PrCreateCapable,
  PrLabelCapable,
  PrReplyCapable,
  WorldSlice,
} from '../src/integrations/integration.js';
import type {
  IssueCommentInput,
  IssueCreateInput,
  PrCreateInput,
  PrLabelInput,
  PrReplyInput,
  SendResult,
} from '../src/sink/actionSink.js';

const DISCLAIMER = 'Automated comment from';

/** Records what actually reached a provider, which is the only place the sign-off can be observed. */
class RecordingIntegration
  implements Integration, PrReplyCapable, PrCreateCapable, IssueCreateCapable, IssueCommentCapable, PrLabelCapable
{
  readonly id = 'sourceControl:recording';
  readonly capability: Capability = 'sourceControl';
  readonly sent: string[] = [];
  readonly labels: PrLabelInput[] = [];

  constructor(readonly bodyFormat: 'markdown' | 'html' = 'markdown') {}

  async snapshot(): Promise<WorldSlice> {
    return {};
  }
  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    this.sent.push(input.body);
    return { ok: true };
  }
  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    this.sent.push(input.body);
    return { ok: true, ref: '1' };
  }
  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    this.sent.push(input.body);
    return { ok: true, ref: 'issue:1' };
  }
  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    this.sent.push(input.body);
    return { ok: true, ref: 'c1' };
  }
  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    this.labels.push(input);
    return { ok: true };
  }
}

test('a signed body keeps its own prose and gains the disclaimer', () => {
  const signed = signOff('Fixed and pushed.', 'markdown');
  assert.match(signed, /^Fixed and pushed\./);
  assert.match(signed, new RegExp(DISCLAIMER));
  assert.match(signed, /LubbDubb/);
});

test('the Markdown rule is preceded by a blank line, so the prose above it is not read as a heading', () => {
  assert.match(signOff('The last line.', 'markdown'), /The last line\.\n\n<!-- lubbdubb:signoff -->\n\n---\n\n/);
});

test('the HTML flavour ships markup rather than Markdown punctuation', () => {
  const signed = signOff('Description.', 'html');
  assert.match(signed, /<hr>/);
  assert.match(signed, /<strong>LubbDubb<\/strong>/);
  assert.doesNotMatch(signed, /\*\*/);
  assert.doesNotMatch(signed, /\n---\n/);
});

test('signing is idempotent, so a body round-tripped through a provider gains no second footer', () => {
  const once = signOff('Body.', 'markdown');
  assert.equal(signOff(once, 'markdown'), once);
  // And the flavour of a re-sign cannot change what is already there.
  assert.equal(signOff(once, 'html'), once);
});

test('the ending is stable for a body, so an edited-in-place comment does not churn its joke', () => {
  assert.equal(signOff('Plan in progress.', 'markdown'), signOff('Plan in progress.', 'markdown'));
});

test('different bodies spread across the endings rather than sharing one', () => {
  const tail = (body: string) => signOff(body, 'markdown').split('so the user can ')[1];
  const endings = new Set(Array.from({ length: 200 }, (_, i) => tail(`body ${i}`)));
  assert.ok(endings.size > 20, `expected a spread of endings, got ${endings.size}`);
});

test('every prose method signs on its way to the provider, whichever surface it is', async () => {
  const provider = new RecordingIntegration();
  const connector = new CompositeConnector([provider]);
  await connector.postPrReply({ prNumber: 1, commentId: null, body: 'A reply.' });
  await connector.createPullRequest({ branch: 'b', base: 'main', title: 'T', body: 'A PR body.' });
  await connector.createIssue({
    title: 'T',
    body: 'A filing.',
    labels: [],
    type: null,
    assignee: null,
    relatedTo: null,
  });
  await connector.upsertIssueComment({ number: 1, body: 'A status.', commentRef: null });

  assert.equal(provider.sent.length, 4);
  for (const body of provider.sent) assert.match(body, new RegExp(DISCLAIMER));
});

test('a provider that renders HTML is signed in HTML', async () => {
  const provider = new RecordingIntegration('html');
  const connector = new CompositeConnector([provider]);
  await connector.upsertIssueComment({ number: 1, body: 'A status.', commentRef: null });
  assert.match(provider.sent[0]!, /<strong>LubbDubb<\/strong>/);
});

test('an act carries no sign-off, having no voice to mistake for a human', async () => {
  const provider = new RecordingIntegration();
  const connector = new CompositeConnector([provider]);
  await connector.setPrLabel({ prNumber: 1, label: 'lubbdubb', present: true });
  assert.deepEqual(provider.labels, [{ prNumber: 1, label: 'lubbdubb', present: true }]);
  assert.equal(provider.sent.length, 0);
});
