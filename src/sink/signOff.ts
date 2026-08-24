/**
 * The harness signing its own work.
 *
 * Every outbound write goes out under the *operator's* credential — their
 * `GITHUB_TOKEN`, their PAT — so a plan comment, an assay question or a review
 * reply arrives on the thread wearing their avatar and their name, indistinguishable
 * from something they typed. That is a misattribution rather than a cosmetic
 * shortfall: a reviewer answers a machine's question believing a colleague asked
 * it, and the thread's permanent record says a person said something they never
 * said.
 *
 * So every piece of prose the harness sends carries a sign-off, and it is
 * **appended** rather than woven into what each caller renders — the same
 * reasoning that keeps additions to prompts out of the templates. A footer six
 * call sites each remember to add is a footer the seventh forgets, and a forgotten
 * one fails silently: the comment posts, reads correctly, and is simply attributed
 * to the wrong author.
 *
 * Unconditional, and deliberately not a config key. A sign-off an operator can
 * switch off is one that is off exactly where the impersonation matters most.
 *
 * It names no account. The avatar beside the comment already says whose
 * credential it went out under, so naming them would restate it — and a line that
 * needs `userId` would have a second, quieter rendering on every deployment that
 * leaves it unset.
 */

/** How a provider renders comment bodies. GitHub speaks Markdown; Azure DevOps renders HTML. */
export type BodyFormat = 'markdown' | 'html';

/**
 * Invisible in both flavours — an HTML comment renders as nothing in Markdown and
 * is dropped by Azure's sanitiser — so it marks a signed body without showing a
 * reader anything. What {@link signOff} reads to stay idempotent.
 */
const MARKER = '<!-- lubbdubb:signoff -->';

/**
 * The sign-off's fixed half. Split where its emphasis falls so both flavours below
 * render the *same* sentence — spelling it out twice is how the Markdown and the
 * HTML wording drift apart, on the half of deployments nobody reads.
 */
const SIGN_OFF = {
  lead: '\u{1F916} Automated comment from ',
  name: 'LubbDubb',
  tail: ' \u2014 automating PR busy work so the user can ',
} as const;

/**
 * The sign-off's moving half.
 *
 * One fixed ending read a hundred times stops being a joke and starts being
 * furniture, which is a real cost: furniture is what a reader's eye learns to skip,
 * and the half of the line that *matters* — that a machine wrote this — rides along
 * with it. A line that ends differently each time keeps getting read.
 *
 * Kept mild on purpose. This lands on threads the operator does not control, in
 * front of reviewers, customers and whoever reads the tracker in a year, so every
 * ending has to be one they would be happy to have said in public.
 */
const ENDINGS = [
  'go to the beach',
  'go outside',
  'take a walk',
  'eat lunch while it is still hot',
  'finish their coffee',
  'have a second cup of coffee',
  'eat breakfast sitting down',
  'take a proper lunch break',
  'watch the whole film',
  'read a book with no code in it',
  'do the crossword',
  'finish the puzzle',
  'sit in the sun',
  'watch the sunset',
  'see daylight',
  'go for a swim',
  'go for a run',
  'go for a hike',
  'go climbing',
  'learn to surf',
  'use the gym they pay for',
  'stretch',
  'take a nap',
  'sleep past six',
  'get eight hours',
  'take the dog out',
  'play with the dog',
  'water the plants',
  'make dinner from scratch',
  'keep a sourdough starter alive',
  'call their mother',
  'see friends on a weeknight',
  'go to a gig',
  'learn the guitar',
  'practise an instrument nobody has to hear',
  'go to the recital',
  'attend their own birthday',
  'have a real weekend',
  'take Friday off',
  'use the annual leave they accrued',
  'go on the holiday they booked',
  'take the long way home',
  'take the train instead of the flight',
  'be somewhere with no signal',
  'leave their laptop shut',
  'close the laptop before midnight',
  'log off at a reasonable hour',
  'have a hobby again',
  'write the novel',
  'finish the side project',
  'learn a language',
  'go to the dentist appointment they keep moving',
  'book the thing they keep not booking',
  'answer the emails that are actually about people',
  'do the washing up',
  'clear the garage',
  'cook something that takes three hours',
  'sit through a whole cup of tea',
  'listen to a full album',
  'go to the museum on a weekday',
  'ride a bike somewhere pointless',
  'stare out of a window',
  'do nothing at all',
  'be a person for an hour',
  'plot world domination',
  'work on their evil laugh',
  'stroke a cat while explaining the plan',
  'return from the volcano lair',
  'assemble the doomsday device that is mostly a spreadsheet',
  'menace a neighbouring hamlet',
  'raise an army of geese',
  'befriend a crow',
  'apologise to the crow',
  'negotiate with a toddler',
  'lose an argument to a toddler',
  'name every duck in the park',
  'win the pub quiz',
  'lose the pub quiz gracefully',
  'become locally famous for a chilli',
  'perfect the roast potato',
  'argue about tabs with someone in person',
  'watch a documentary about crabs',
  'become slightly obsessed with crabs',
  'buy a boat they cannot afford',
  'learn the names of three clouds',
  'take up the accordion',
  'be asked to stop taking up the accordion',
  'start a band that plays once',
  'write a strongly worded letter to a council',
  'stand in a river wearing waders',
  'catch nothing, contentedly',
  'grow a marrow of concerning size',
  'enter the marrow in a competition',
  'lose to a better marrow',
  'restore a motorbike very slowly',
  'reorganise the shed',
  'undo the reorganisation of the shed',
  'read the manual for something they already own',
  'do a jigsaw with the cat sitting on it',
  'teach the dog a trick it will not learn',
  'walk the length of a beach for no reason',
  'skim a stone more than four times',
  'sit in a garden centre café',
  'have opinions about hedges',
  'sleep in a tent on purpose',
  'be rained on, philosophically',
  'take a photograph of the same tree again',
  'get very into bread',
  'get over being into bread',
  'have a nap so good it is talked about',
] as const;

/**
 * Which ending this body gets — chosen from the body itself rather than from a
 * random number, and that is deliberate.
 *
 * Two of these surfaces are **edited in place**: the plan's status comment and the
 * assay question are one living comment re-rendered as things change. A random
 * ending would move under every edit, filling the thread's revision history with
 * diffs whose only content is the joke — and inviting a reader to wonder what else
 * changed. Hashing the body gives the same spread across comments while holding
 * each comment's own ending still, and keeps the function pure, so nothing here
 * needs a clock or a seed injected to be testable.
 */
function ending(body: string): string {
  // FNV-1a, for spread rather than for secrecy: two bodies differing by one
  // character must not land on neighbouring endings.
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ENDINGS[hash % ENDINGS.length] as string;
}

/**
 * `body` with the harness's sign-off appended, in `format`'s markup.
 *
 * Idempotent on the marker: a body already carrying one comes back untouched, so a
 * caller handing back a previously-signed body — a comment read from the provider
 * and re-sent — does not accumulate footers.
 */
export function signOff(body: string, format: BodyFormat): string {
  if (body.includes(MARKER)) return body;
  const { lead, name, tail } = SIGN_OFF;
  const line = `${tail}${ending(body)}.`;
  if (format === 'html') return `${body}\n${MARKER}\n<hr>\n<p>${lead}<strong>${name}</strong>${line}</p>`;
  // The blank line above the rule is load-bearing: without it a Markdown renderer
  // reads `---` as underlining the line before, turning the last line of the
  // agent's own prose into a heading.
  return `${body}\n\n${MARKER}\n\n---\n\n${lead}**${name}**${line}`;
}
