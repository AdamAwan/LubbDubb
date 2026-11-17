import type { ExtraMcpServer, RecordingStatus, Task } from '../types.js';

// → docs/spec/32-local-validation.md#the-recording, docs/spec/36-remote-validation.md#the-runs-recording

export function recordingInstructions(browserKey: string, input: { where: string; chapter: string }): string {
  return (
    `### Record the run\n\n` +
    `The operator judges this run by watching it, so record it as a video. Once the application is open:\n\n` +
    `1. \`browser_start_video\`, with **no** \`filename\` — the video is then saved into ${input.where}, ` +
    `which is where the harness looks for it. Pass \`cursor: true\`.\n` +
    `2. \`browser_video_show_actions\`, so every click and keystroke is labelled on screen.\n` +
    `3. Before each step, \`browser_video_chapter\` with a short title naming it — ${input.chapter}. The ` +
    `chapters are how somebody skips to the step they care about.\n` +
    `4. \`browser_stop_video\` once the last step is done, **before** you report. A video that is never ` +
    `stopped is never written.\n\n` +
    `These tools are on the \`${browserKey}\` server only where this deployment enabled them. If they are not ` +
    `there, or \`browser_start_video\` answers with an error, carry on without a recording: it is not a finding ` +
    `and it is not a reason to report \`blocked\`. The harness sees for itself whether a video was written, so ` +
    `do not report on it — and a file name in \`browser_stop_video\`'s answer is no proof that one was.\n`
  );
}

export function recorderOffered(server: ExtraMcpServer | null): boolean {
  if (server === null) return false;
  return server.args.some((arg, i) => {
    const caps = arg.startsWith('--caps=')
      ? arg.slice('--caps='.length)
      : arg === '--caps'
        ? server.args[i + 1]
        : undefined;
    return caps !== undefined && caps.split(',').some((cap) => cap.trim() === 'devtools');
  });
}

/**
 * Null is *not known*: the directory could not be read, the agent's task is gone, or a blocked run left
 * no video and may never have got as far as recording. The offer is read off the servers the agent was
 * launched with, never the live config, which can have moved since.
 */
export function recordingStatus(task: Task | null, video: boolean | null, blocked: boolean): RecordingStatus | null {
  if (video === null) return null;
  if (video) return 'kept';
  if (blocked || task === null) return null;
  return task.mcpServers?.some(recorderOffered) === true ? 'missing' : 'not_offered';
}
