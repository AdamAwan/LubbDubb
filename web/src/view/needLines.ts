// → docs/spec/17-cockpit.md#a-row-is-one-factual-line

/* The server words the queue's rows; these are the same functions, so a line the cockpit composes
   itself — a folded group's title, a thread summary in an ask body — cannot word it differently. */
export { askLine, oneLine } from '../../../src/wire.js';
