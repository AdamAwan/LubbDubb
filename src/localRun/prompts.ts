// → docs/spec/23-local-runs.md

export const RUN_RULES = [
  'How this works, on top of the above:',
  '',
  '- Start it in the **background** and leave it running. This session stays open to hold it: the',
  '  server is a child of this process, so if you run it in the foreground you block your own turn,',
  '  and if you stop it before you finish there is nothing left running.',
  '- **Do not stop it, and do not tidy up.** Finishing your turn is not the end of the run — somebody',
  '  is about to look at what you started. It is stopped from the cockpit, which kills this session.',
  '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else',
  '  wrote and is here to be looked at, not worked on. If it will not start, say why and stop.',
  '- **Say where it landed** — the URL and the port — and say what you had to do that the instruction',
  '  above did not mention. That last part is how the instruction gets better.',
  '- **Before each step, print one line saying what you are about to do, starting with `phase:`** — for',
  '  example `phase: starting the containers`. Somebody is watching this come up and that line is all',
  '  they have to go on until it does. A few words, on a line of its own.',
].join('\n');

export const RESUME_RULES = [
  'How this works, on top of the above:',
  '',
  '- **You did not start this, and the session that did is gone.** The harness restarted underneath it.',
  '  Whatever survived that — containers, listening ports, background processes — is this run’s own work,',
  '  not a collision: attach to it, restart only the pieces that did not survive, and do not bring up a',
  '  second copy of anything already up.',
  '- Start whatever you do have to start in the **background** and leave it running. This session stays',
  '  open to hold it: the server is a child of this process, so if you run it in the foreground you block',
  '  your own turn, and if you stop it before you finish there is nothing left running.',
  '- **Do not stop it, and do not tidy up.** Finishing your turn is not the end of the run — somebody',
  '  is about to look at what you brought back. It is stopped from the cockpit, which kills this session.',
  '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else',
  '  wrote and is here to be looked at, not worked on. If it will not come back, say why and stop.',
  '- **Say where it landed** — the URL and the port — and say what you found already running and what you',
  '  had to start again. That second half is how the instruction gets better.',
  '- **Before each step, print one line saying what you are about to do, starting with `phase:`** — for',
  '  example `phase: checking what is still up`. Somebody is watching this come back and that line is all',
  '  they have to go on until it does. A few words, on a line of its own.',
].join('\n');

export const STOP_RULES = [
  'How this works, on top of the above:',
  '',
  '- **Stop everything that start brought up**, including anything you started that the instruction',
  '  above did not mention. Containers, background processes, ports — the machine should be as it was.',
  '- **Do not commit, push, or change code.** This checkout is somebody else’s commit, and it is about',
  '  to be pointed at another one.',
  '- **Say what you stopped, and what you could not.** The second half is the useful half: anything',
  '  still holding a port is what the next start will collide with.',
  '- **Before each step, print one line starting with `phase:`** — somebody is watching this come down,',
  '  and that line is all they have to go on until it has.',
].join('\n');

export const STOP_RULES_ALONE = [
  'How this works, on top of the above:',
  '',
  '- **You did not start this, and the session that did is gone.** Whatever it left running is still',
  '  running: look for it — containers, listening ports, background processes — and stop it.',
  '- **Do not commit, push, or change code.** This checkout is somebody else’s commit, and it is about',
  '  to be pointed at another one.',
  '- **Say what you stopped, and what you could not.** The second half is the useful half: anything',
  '  still holding a port is what the next start will collide with.',
  '- **Before each step, print one line starting with `phase:`** — somebody is watching this come down,',
  '  and that line is all they have to go on until it has.',
].join('\n');

export function refreshRules(ref: string, from: string | null, to: string, alone: boolean): string {
  return [
    alone ? 'The code under this environment has changed:' : 'How this works, on top of the above:',
    '',
    `- **The checkout under you has moved.** It now stands at ${to.slice(0, 12)} on \`${ref}\`` +
      (from === null ? '.' : `, having stood at ${from.slice(0, 12)}.`) +
      ' The files on disk already reflect the new commit; nothing has been restarted or rebuilt.',
    '- **Restart or rebuild whatever needs it** so what is running reflects the new code. A dev server that',
    '  hot-reloads may need nothing; a container image or a database schema may need a step. Leave alone',
    '  what does not need touching.',
    '- **Do not stop the environment.** Somebody is looking at it — keep it up throughout.',
    '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else wrote.',
    '- **Say what you did and what you did not need to touch.** The second half is how the refresh',
    '  instruction gets better.',
    '- **Before each step, print one line starting with `phase:`** — somebody is watching this and that',
    '  line is all they have to go on until it is done.',
  ].join('\n');
}

export function phaseOf(line: string): string | null {
  const plain = line.split('**').join('').trim();
  const bare = plain.replace(/^[-*>#]+/, '').trim();
  const said = bare.toLowerCase().startsWith('phase:') ? bare.slice('phase:'.length).trim() : '';
  return said === '' ? null : said;
}
