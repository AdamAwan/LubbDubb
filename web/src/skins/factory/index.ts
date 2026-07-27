import type { Skin } from '../types.js';
import { FactoryRoot } from './FactoryRoot.js';

export const factorySkin: Skin = {
  id: 'factory',
  label: 'Factory Floor',
  description: 'The queue as a belt, the fleet as machine bays, the cap as a gate',
  Root: FactoryRoot,
};
