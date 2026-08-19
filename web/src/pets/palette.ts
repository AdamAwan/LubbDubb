/**
 * A pet's colours, derived from the action key it hatched from.
 *
 * This is what does the work of an art budget. The alternative to it is either
 * forty hand-drawn species or forty identical sprites, and both are worse than
 * nine species that each have individuals: two `pip`s share a grid, so they are
 * recognisably the same animal, and they differ in every colour, so they are
 * visibly not the same pet.
 *
 * The seed is the same string the drop was rolled from, which is the point — the
 * hash that decided you got a creature is the hash that decides what it looks
 * like, and neither can be re-rolled after the fact.
 */

/** FNV-1a again rather than imported across the seam: the cockpit bundles no server code. */
function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** The five inks one sprite is drawn in. */
interface PetPalette {
  outline: string;
  body: string;
  highlight: string;
  eye: string;
  marking: string;
}

/**
 * Hue is free; saturation and lightness are not.
 *
 * The vivarium sits on the rail's own panel in both themes, so a creature that
 * drew itself at whatever lightness the hash landed on would be invisible on one
 * of them every ninth pet. Clamping the two axes that carry contrast — and
 * leaving hue to vary fully — is what keeps every individual legible without
 * making them look like a set.
 */
export function paletteFor(seed: string): PetPalette {
  const hash = hash32(seed);
  const hue = hash % 360;
  // A second, independent read of the same hash, so two pets one apart in hue are
  // not also one apart in every other axis.
  const shift = (hash >>> 9) % 40;
  return {
    outline: `hsl(${hue} 55% 22%)`,
    body: `hsl(${hue} ${58 + (shift % 18)}% 62%)`,
    highlight: `hsl(${hue} 85% 84%)`,
    eye: `hsl(${hue} 60% 14%)`,
    marking: `hsl(${(hue + 24 + shift) % 360} 70% 74%)`,
  };
}
