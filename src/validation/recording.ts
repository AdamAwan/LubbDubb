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
    `there, carry on without a recording: it is not a finding and it is not a reason to report \`blocked\`.\n`
  );
}
