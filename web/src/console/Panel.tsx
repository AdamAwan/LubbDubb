import { Modal } from '../components/Modal.js';
import { Button } from '../components/button.js';

/**
 * A full-surface panel with three ways out — the backdrop, the button and
 * Escape. A thing that covers the console must not have exactly one exit.
 *
 * All three come from {@link Modal}; what stays here is the console's own head.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal face="panel" label={title} onClose={onClose}>
      <header className="cn-panel-head">
        <h2>{title}</h2>
        <Button family="console" onClick={onClose}>
          Close
        </Button>
      </header>
      {children}
    </Modal>
  );
}
