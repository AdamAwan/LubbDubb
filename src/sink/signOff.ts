// → docs/spec/15-integrations.md

export type BodyFormat = 'markdown' | 'html';

const MARKER = '<!-- lubbdubb:signoff -->';

const SIGN_OFF = {
  lead: '\u{1F916} Automated comment from ',
  name: 'LubbDubb',
  tail: ' \u2014 automating PR busy work so the user can ',
} as const;

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

function ending(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ENDINGS[hash % ENDINGS.length] as string;
}

export function signOff(body: string, format: BodyFormat): string {
  if (body.includes(MARKER)) return body;
  const { lead, name, tail } = SIGN_OFF;
  const line = `${tail}${ending(body)}.`;
  if (format === 'html') return `${body}\n${MARKER}\n<hr>\n<p>${lead}<strong>${name}</strong>${line}</p>`;
  return `${body}\n\n${MARKER}\n\n---\n\n${lead}**${name}**${line}`;
}
