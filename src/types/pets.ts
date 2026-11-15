export type PetSpecies =
  | 'pip'
  | 'mote'
  | 'nib'
  | 'tuft'
  | 'beck'
  | 'berth'
  | 'stoke'
  | 'speck'
  | 'patch'
  | 'warden'
  | 'cinder'
  | 'nocturne'
  | 'chit'
  | 'vellum'
  | 'drift'
  | 'bramble'
  | 'lander'
  | 'quill'
  | 'cairn'
  | 'ingot'
  | 'clarion'
  | 'covenant'
  | 'oracle'
  | 'keystone'
  | 'forge'
  | 'lodestone'
  | 'ouroboros';

export type PetRarity = 'common' | 'uncommon' | 'rare' | 'mythic';

export type PetStage = 'hatchling' | 'juvenile' | 'adult';

export type PetActionKind = 'escalation' | 'human-task' | 'plan' | 'landing' | 'job' | 'claim' | 'finding' | 'upgrade';

export interface Pet {
  id: string;
  species: PetSpecies;
  seed: string;
  name: string | null;
  fed: number;
  originKind: PetActionKind;
  originRef: string;
  hatchedAt: string;
  openedAt: string | null;
  placed: boolean;
  dissolvedAt: string | null;
  builtSha: string | null;
  builtClean: boolean;
  chain: string | null;
}

export interface PetFlaw {
  code: 'unrecorded' | 'misdated' | 'impossible' | 'overfed' | 'broken-chain' | 'unearned';
  note: string;
}

export type PetProvenance = 'official' | 'modified' | 'unknown';

export interface PetAction {
  kind: PetActionKind;
  ref: string;
  at: string;
  petId: string | null;
}

export interface PetWallet {
  earned: number;
  spent: number;
  balance: number;
}

export interface PetReset {
  id: string;
  at: string;
  cleared: number;
}
