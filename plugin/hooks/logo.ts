const ART = [
  '.......RR.......',
  '.......##.......',
  '..############..',
  '.##############.',
  '.##############.',
  '.###oo####oo###.',
  'R###oo####oo###R',
  'R##############R',
  'R##############R',
  'R##############R',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '..############..',
  '................',
]

const BEAT: readonly (readonly [number, number])[] = [
  [3, 11], [4, 11], [5, 11], [6, 10], [7, 9], [8, 10], [8, 11], [8, 12], [9, 11], [10, 11], [11, 10], [12, 11],
]
const PULSE = 3

const INK: Record<string, number | null> = {
  '.': null,
  o: null,
  '#': 0xd4d4d8,
  R: 0xe5484d,
  r: 0x5a2a2c,
  T: 0x55555c,
}
const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584

export const LOGO_COLUMNS = ART[0]!.length
export const LOGO_ROWS = ART.length / 2
export const LOGO_FRAMES = BEAT.length + PULSE

/** The robot at `frame` of its heartbeat, or flat-lined for `null`, packed as a Raster's `cells`. */
export function logoCells(frame: number | null): string {
  const grid = ART.map(row => row.split(''))
  if (frame === null) {
    for (let x = 3; x <= 12; x++) grid[11]![x] = 'T'
  } else {
    const at = frame % LOGO_FRAMES
    BEAT.forEach(([x, y], i) => (grid[y]![x] = at - PULSE < i && i <= at ? 'R' : 'T'))
    if (at >= LOGO_FRAMES / 2) grid[0]![7] = grid[0]![8] = 'r'
  }
  const words = new Uint32Array(LOGO_COLUMNS * LOGO_ROWS * 3)
  for (let row = 0; row < LOGO_ROWS; row++) {
    for (let x = 0; x < LOGO_COLUMNS; x++) {
      const top = INK[grid[row * 2]![x]!] ?? null
      const bottom = INK[grid[row * 2 + 1]![x]!] ?? null
      const cell = [
        top === null && bottom === null ? 0x20 : top === null ? LOWER : UPPER,
        top ?? bottom ?? DEFAULT,
        top === null ? DEFAULT : (bottom ?? DEFAULT),
      ]
      words.set(cell, (row * LOGO_COLUMNS + x) * 3)
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const MOUTH = '34,80 46,80 51,71 57,89 62,80 70,80 73,76 76,84 79,80 86,80'

/** The same robot for the surfaces that draw SVG, animated while `alive`. */
export function logoSvg(alive: boolean): string {
  const mouth = alive ? MOUTH : '34,80 86,80'
  const pulse = alive
    ? `<polyline class="p" points="${MOUTH}" fill="none" stroke="#e5484d" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><style>
.h{fill:#111}.s{stroke:#111}.t{stroke:#3a3a3e}.e{fill:#fff}
@media (prefers-color-scheme:dark){.h{fill:#d4d4d8}.s{stroke:#d4d4d8}.t{stroke:#55555c}.e{fill:#1e1e1e}}
.a{animation:b 1.2s infinite}.p{stroke-dasharray:30 120;animation:m 1.2s linear infinite}
@keyframes b{0%,70%,100%{opacity:1}35%{opacity:.25}}@keyframes m{from{stroke-dashoffset:30}to{stroke-dashoffset:-110}}
@media (prefers-reduced-motion:reduce){.a,.p{animation:none}.p{stroke-dasharray:none}}
</style><rect x="12" y="56" width="10" height="20" rx="4" fill="#e5484d"/><rect x="98" y="56" width="10" height="20" rx="4" fill="#e5484d"/><line class="s" x1="60" y1="34" x2="60" y2="22" stroke-width="5" stroke-linecap="round"/><circle${alive ? ' class="a"' : ''} cx="60" cy="18" r="6" fill="#e5484d"/><rect class="h" x="20" y="34" width="80" height="64" rx="18"/><circle class="e" cx="44" cy="58" r="7"/><circle class="e" cx="76" cy="58" r="7"/><polyline class="t" points="${mouth}" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>${pulse}</svg>`
}
