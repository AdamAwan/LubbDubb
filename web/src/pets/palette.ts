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

/** The inks one sprite is drawn in. */
interface PetPalette {
  outline: string;
  body: string;
  highlight: string;
  eye: string;
  marking: string;
  /** The lit body's underside. → {@link inkFor} */
  shade: string;
  /** The mythic's light, spilled one pixel past the outline. */
  glow: string;
  /** The rare's four sparks at the bounding box. */
  glint: string;
  sparkCore: string;
  sparkArm: string;
}

/**
 * Hue is free; saturation and lightness are not.
 *
 * The vivarium sits on the rail's own panel in both themes, so a creature that
 * drew itself at whatever lightness the hash landed on would be invisible on one
 * of them every ninth pet. Clamping the two axes that carry contrast — and
 * leaving hue to vary fully — is what keeps every individual legible without
 * making them look like a set.
 *
 * The five decoration inks below the first five follow the same rule and the same
 * two hues: the body's for light on the body, the marking's for everything that
 * leaves the outline. A rarity device drawn in a hue of its own would be the one
 * thing on the creature the seed did not choose.
 */
export function paletteFor(seed: string): PetPalette {
  const hash = hash32(seed);
  const hue = hash % 360;
  // A second, independent read of the same hash, so two pets one apart in hue are
  // not also one apart in every other axis.
  const shift = (hash >>> 9) % 40;
  const markHue = (hue + 24 + shift) % 360;
  return {
    outline: `hsl(${hue} 55% 22%)`,
    body: `hsl(${hue} ${58 + (shift % 18)}% 62%)`,
    highlight: `hsl(${hue} 85% 84%)`,
    eye: `hsl(${hue} 60% 14%)`,
    marking: `hsl(${markHue} 70% 74%)`,
    shade: `hsl(${hue} ${52 + (shift % 14)}% 44%)`,
    glow: `hsl(${markHue} 88% 74% / 0.42)`,
    glint: `hsl(${markHue} 92% 82%)`,
    sparkCore: `hsl(${markHue} 96% 93%)`,
    sparkArm: `hsl(${markHue} 92% 80% / 0.8)`,
  };
}

/**
 * Which ink each character of a grid is drawn in, and the only mapping of that.
 *
 * Here rather than in `SpeciesSprite` because the grid characters are now
 * produced by two things — the hand-placed grids and the passes in `sprites.ts` —
 * and a pass that emits a character the draw loop has no colour for draws
 * *nothing*: no error, no blank, just a device silently missing from one tier.
 * `test/petSprites.test.ts` holds every character either can emit against this.
 *
 * `undefined` is "leave the canvas alone", which is what `.` means and what the
 * crack overlay's `k` relies on.
 */
export function inkFor(palette: PetPalette): Readonly<Record<string, string | undefined>> {
  return {
    o: palette.outline,
    O: palette.body,
    h: palette.highlight,
    e: palette.eye,
    m: palette.marking,
    d: palette.shade,
    g: palette.glow,
    s: palette.glint,
    A: palette.sparkCore,
    a: palette.sparkArm,
  };
}
