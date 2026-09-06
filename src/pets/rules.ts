import type { PetActionKind, PetRarity } from '../types.js';

// → docs/spec/22-pets.md

export interface PetRules {
  rates: Record<PetActionKind, PetActionRate>;
  rarity: Record<PetRarity, number>;
  beatsPerDollar: number;
  blendYield: number;
}

export interface PetActionRate {
  dropChance: number;
  pity: number;
}

export const PET_RULES: PetRules = Object.freeze({
  rates: Object.freeze({
    job: Object.freeze({ dropChance: 0.015, pity: 130 }),
    claim: Object.freeze({ dropChance: 0.02, pity: 100 }),
    finding: Object.freeze({ dropChance: 0.02, pity: 100 }),
    'human-task': Object.freeze({ dropChance: 0.03, pity: 66 }),
    escalation: Object.freeze({ dropChance: 0.04, pity: 50 }),
    plan: Object.freeze({ dropChance: 0.05, pity: 40 }),
    landing: Object.freeze({ dropChance: 0.08, pity: 25 }),
    upgrade: Object.freeze({ dropChance: 0.2, pity: 10 }),
  }),
  rarity: Object.freeze({ common: 700, uncommon: 200, rare: 80, mythic: 20 }),
  beatsPerDollar: 25,
  blendYield: 500,
});
