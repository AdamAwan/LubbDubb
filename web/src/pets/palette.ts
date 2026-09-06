// → docs/spec/22-pets.md

function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface PetPalette {
  outline: string;
  body: string;
  highlight: string;
  eye: string;
  marking: string;
  shade: string;
  glow: string;
  glint: string;
  sparkCore: string;
  sparkArm: string;
}

export function paletteFor(seed: string): PetPalette {
  const hash = hash32(seed);
  const hue = hash % 360;
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
