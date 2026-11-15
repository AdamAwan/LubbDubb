import type { PetRules } from '../pets/rules.js';
import type {
  Pet,
  PetActionKind,
  PetFlaw,
  PetProvenance,
  PetRarity,
  PetSpecies,
  PetStage,
  PetWallet,
} from '../types.js';

export interface PetView extends Pet {
  rarity: PetRarity;
  display: string;
  stage: PetStage;
  beatsToNextStage: number | null;
  flaw: PetFlaw | null;
  originLabel: string | null;
  provenance: PetProvenance;
}

export interface PetCatalogueEntry {
  species: PetSpecies;
  display: string;
  rarity: PetRarity;
  growth: number;
  juvenileAt: number;
  adultAt: number;
  blend: number;
  share: number;
  kinds: PetActionKind[];
  hours: number[] | null;
}

export interface PetCatalogueSource {
  kind: PetActionKind;
  rolled: PetRarity;
  landed: PetRarity;
  members: PetSpecies[];
}

export interface PetCatalogue {
  rules: PetRules;
  rarities: PetRarity[];
  species: PetCatalogueEntry[];
  sources: PetCatalogueSource[];
}

export interface PetState {
  pets: PetView[];
  wallet: PetWallet;
  slots: number;
  startedAt: string | null;
}
