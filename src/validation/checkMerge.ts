import type { ValidationCheck, ValidationCheckInput, ValidationRevision } from '../types.js';

export function mergeCheck(args: {
  originRef: string;
  prev: ValidationCheck | undefined;
  input: ValidationCheckInput;
  letter: string;
  ts: string;
  amendNote: string | null;
}): ValidationCheck {
  const { originRef, prev, input, letter, ts, amendNote } = args;
  const reworded = prev !== undefined && isReworded(prev, input);
  const reading = keptReading(prev !== undefined && !reworded ? prev : undefined);
  const changed = prev === undefined || reworded || prev.supersededReason !== null;
  const amended = amendNote !== null && changed ? band(prev, reworded, ts, amendNote) : carriedBand(prev);
  return {
    originRef,
    id: input.id,
    letter,
    seq: input.seq,
    title: input.title,
    do: input.do,
    expect: input.expect,
    proof: input.proof,
    uses: input.uses,
    covers: input.covers,
    satisfies: input.satisfies ?? prev?.satisfies ?? [],
    fleetCandidate: input.fleetCandidate,
    candidateWhy: input.candidateWhy,
    actor: reading.actor,
    handbackNote: reading.handbackNote,
    claimedBy: reading.claimedBy,
    claimedAt: reading.claimedAt,
    state: reading.state,
    resultNote: reading.resultNote,
    resultBy: reading.resultBy,
    resultAt: reading.resultAt,
    deferUntil: reading.deferUntil,
    supersededReason: null,
    revision: amended.revision,
    amendedAt: amended.amendedAt,
    amendNote: amended.amendNote,
    // Resolved from the configuration at ingestion and recomputed on every amendment — a check's
    // assignment is a fact about what the deployment declares, and a step whose kind nothing
    // declares is a step the fleet cannot carry. The area and the expected spec names ride here
    // too: they are read off the steps wherever they are needed and are held nowhere else.
    // → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
    steps: input.steps ?? [],
    // A reworded check loses its reading, and the capture is that reading's evidence: an image of
    // a screen the procedure no longer describes is worse than no image, because it looks like one
    // somebody could still judge. Word for word re-declared, it stays.
    capture: reading.capture,
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
  };
}

type Reading = Pick<
  ValidationCheck,
  | 'actor'
  | 'handbackNote'
  | 'claimedBy'
  | 'claimedAt'
  | 'state'
  | 'resultNote'
  | 'resultBy'
  | 'resultAt'
  | 'deferUntil'
  | 'capture'
>;

function keptReading(prev: ValidationCheck | undefined): Reading {
  if (prev === undefined)
    return {
      actor: 'human',
      handbackNote: null,
      claimedBy: null,
      claimedAt: null,
      state: 'unrun',
      resultNote: null,
      resultBy: null,
      resultAt: null,
      deferUntil: null,
      capture: null,
    };
  return {
    actor: prev.actor,
    handbackNote: prev.handbackNote,
    claimedBy: prev.claimedBy,
    claimedAt: prev.claimedAt,
    state: prev.state,
    resultNote: prev.resultNote,
    resultBy: prev.resultBy,
    resultAt: prev.resultAt,
    deferUntil: prev.deferUntil,
    capture: prev.capture,
  };
}

type Band = Pick<ValidationCheck, 'revision' | 'amendedAt' | 'amendNote'>;

function band(prev: ValidationCheck | undefined, reworded: boolean, ts: string, amendNote: string): Band {
  return {
    revision: reworded && prev !== undefined ? (unanswered(prev) ?? priorWording(prev)) : null,
    amendedAt: ts,
    amendNote,
  };
}

function carriedBand(prev: ValidationCheck | undefined): Band {
  return {
    revision: prev?.revision ?? null,
    amendedAt: prev?.amendedAt ?? null,
    amendNote: prev?.amendNote ?? null,
  };
}

export function isReworded(prev: ValidationCheck, next: ValidationCheckAmendmentLike): boolean {
  return (
    prev.title !== next.title ||
    prev.do !== next.do ||
    prev.expect !== next.expect ||
    // The evidence demanded is part of the terms a reading was taken against: a pass earned by
    // handing back one screen is not a pass under a `proof` that now asks for another.
    prev.proof !== next.proof
  );
}

interface ValidationCheckAmendmentLike {
  title: string;
  do: string;
  expect: string;
  proof: string | null;
}

function unanswered(prev: ValidationCheck): ValidationRevision | null {
  return prev.state === 'unrun' && prev.revision !== null && prev.revision.state !== null ? prev.revision : null;
}

function priorWording(prev: ValidationCheck): ValidationRevision {
  return {
    title: prev.title,
    do: prev.do,
    expect: prev.expect,
    proof: prev.proof,
    state: prev.state === 'unrun' ? null : prev.state,
    note: prev.resultNote,
  };
}
