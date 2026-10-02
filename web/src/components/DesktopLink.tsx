import type { JSX } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';
import { BareLink, LinkButton, type OpenUsage } from './button.js';
import { CONTROL_CLASS, useInControlRow } from './controls.js';
import { Icon } from './icons.js';

// → docs/spec/17-cockpit.md

export function DesktopLink({
  folder,
  prompt,
  explain,
  ready = 'ready to send',
  label = 'Open in Claude Code',
  control,
  fullSize = false,
  usage,
}: {
  folder: string;
  prompt: string;
  explain: string;
  ready?: string;
  label?: string;
  control?: boolean;
  /** Beside a full-size press, at its size rather than the small one a link usually wears. */
  fullSize?: boolean;
  usage: OpenUsage;
}): JSX.Element {
  const inControlRow = useInControlRow();
  const asControl = control ?? inControlRow;
  const link = {
    usage,
    href: desktopDeepLink(folder, prompt),
    title: `Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`,
    children: (
      <>
        <Icon name="chat" />
        {label} ↗
      </>
    ),
  };
  return asControl ? (
    <BareLink className={CONTROL_CLASS} {...link} />
  ) : (
    <LinkButton {...link} ghost size={fullSize ? undefined : 'small'} />
  );
}
