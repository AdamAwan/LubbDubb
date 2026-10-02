import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { Button } from '../components/button.js';
import { usePluginStatus } from '../components/PluginStep.js';

// → docs/spec/17-cockpit.md#the-plugin

export function PluginBand({ actions }: { actions: CockpitActions }): JSX.Element | null {
  const status = usePluginStatus();
  if (status === null || (status.state !== 'missing' && status.state !== 'stale')) return null;
  return (
    <div className="park-notice plugin-band">
      <span>
        <b>
          {status.state === 'missing' ? 'The LubbDubb plugin is not installed.' : 'The LubbDubb plugin is out of date.'}
        </b>{' '}
        Every <i>Open in Claude Code</i> link calls one of its skills.
      </span>
      <Button size="small" usage={{ counted: 'config.view' }} onClick={() => actions.openConfig({ configTab: 'mcp' })}>
        {status.state === 'missing' ? 'Install it' : 'Update it'}
      </Button>
    </div>
  );
}
