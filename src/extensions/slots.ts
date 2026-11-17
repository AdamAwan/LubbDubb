import type { SlotBook, SlotSignature } from './contract.js';

// → docs/spec/42-extensions.md#the-slots

export type ExtensionSlots = Record<never, SlotSignature>;

export const EXTENSION_SLOTS: SlotBook<ExtensionSlots> = {};
