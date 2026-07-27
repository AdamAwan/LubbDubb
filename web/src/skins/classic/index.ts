import type { Skin } from '../types.js';
import { ClassicRoot } from './ClassicRoot.js';

export const classicSkin: Skin = {
  id: 'classic',
  label: 'Classic',
  description: 'The original three-column cockpit',
  Root: ClassicRoot,
};
