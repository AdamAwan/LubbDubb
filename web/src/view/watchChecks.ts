// → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set

/* The server's own reading of a proposed check, so the Signals card and the stage pill cannot
   disagree with the window pass about which checks are still the operator's to accept. */
export { isProposed } from '../../../src/wire.js';
