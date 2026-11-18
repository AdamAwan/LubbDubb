import { spawnSync } from 'node:child_process';
import { bundledPlaywright } from '../src/validation/local/policy.js';

// → docs/spec/32-local-validation.md#the-recording

const bundled = bundledPlaywright();
if (typeof bundled === 'string') console.warn(`lubbdubb: the bundled @playwright/mcp is not usable — ${bundled}`);
else {
  const { coreCli, ffmpegRevision } = bundled;
  const result = spawnSync(process.execPath, [coreCli, 'install', 'ffmpeg'], { stdio: 'inherit' });
  if (result.status !== 0)
    console.warn(
      `lubbdubb: could not install Playwright's ffmpeg-${ffmpegRevision}; validation runs will not be recorded ` +
        `until \`node ${coreCli} install ffmpeg\` succeeds.`,
    );
}
