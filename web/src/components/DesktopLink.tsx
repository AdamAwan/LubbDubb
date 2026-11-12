import type { JSX } from 'react';
import { desktopDeepLink } from '../cockpit/desktopLink.js';
import { BareLink, LinkButton, type OpenUsage } from './button.js';
import { CONTROL_CLASS, useInControlRow } from './controls.js';
import { Icon } from './icons.js';
import { flashClass, useAsyncAction } from './AsyncButton.js';

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
  onOpen,
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
  /** Fired by the click and not awaited by it, so the deep link opens inside the click's own gesture. */
  onOpen?: () => Promise<unknown>;
}): JSX.Element {
  const inControlRow = useInControlRow();
  const { phase, refusal, run } = useAsyncAction();
  const asControl = control ?? inControlRow;
  const link = {
    usage,
    href: desktopDeepLink(folder, prompt),
    title: refusal ?? `Opens your own Claude Code with "${prompt.trim()}" ${ready}, ${explain}`,
    ...(onOpen === undefined ? {} : { onClick: () => void run(onOpen) }),
    children: (
      <>
        <Icon name="chat" />
        {label} ↗
      </>
    ),
  };
  return asControl ? (
    <BareLink className={[CONTROL_CLASS, flashClass(phase)].filter((c) => c !== '').join(' ')} {...link} />
  ) : (
    <LinkButton {...link} className={flashClass(phase)} ghost size={fullSize ? undefined : 'small'} />
  );
}
