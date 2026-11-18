import { spawnSync } from 'node:child_process';
import { bundledPlaywright } from '../src/validation/local/policy.js';

// → docs/spec/32-local-validation.md#the-recording

const { coreCli, ffmpegRevision } = bundledPlaywright();
const result = spawnSync(process.execPath, [coreCli, 'install', 'ffmpeg'], { stdio: 'inherit' });
if (result.status !== 0)
  console.warn(
    `lubbdubb: could not install Playwright's ffmpeg-${ffmpegRevision}; validation runs will not be recorded ` +
      `until \`node ${coreCli} install ffmpeg\` succeeds.`,
  );
