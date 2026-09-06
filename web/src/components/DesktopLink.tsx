import type { JSX } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';
import { buttonClass } from './button.js';
import { Icon } from './icons.js';

// → docs/spec/17-cockpit.md

export function DesktopLink({
  folder,
  prompt,
  explain,
  ready = 'ready to send',
  label = 'Open in Claude Code',
}: {
  folder: string;
  prompt: string;
  explain: string;
  ready?: string;
  label?: 'Open in Claude Code' | 'Question?';
}): JSX.Element {
  return (
    <a
      className={buttonClass({ ghost: true, size: 'small' })}
      href={desktopDeepLink(folder, prompt)}
      title={`Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`}
    >
      <Icon name="chat" />
      {label} ↗
    </a>
  );
}
