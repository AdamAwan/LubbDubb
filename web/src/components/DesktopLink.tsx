import type { JSX } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';
import { buttonClass } from './button.js';
import { CONTROL_CLASS } from './controls.js';
import { Icon } from './icons.js';

// → docs/spec/17-cockpit.md

export function DesktopLink({
  folder,
  prompt,
  explain,
  ready = 'ready to send',
  label = 'Open in Claude Code',
  control,
}: {
  folder: string;
  prompt: string;
  explain: string;
  ready?: string;
  label?: 'Open in Claude Code' | 'Question?';
  control?: boolean;
}): JSX.Element {
  return (
    <a
      className={control === true ? CONTROL_CLASS : buttonClass({ ghost: true, size: 'small' })}
      href={desktopDeepLink(folder, prompt)}
      title={`Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`}
    >
      <Icon name="chat" />
      {label} ↗
    </a>
  );
}
