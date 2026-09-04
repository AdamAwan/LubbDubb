import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTheme,
  applyToken,
  isTokenValue,
  PRESETS,
  readThemePrefs,
  setThemeUnsaved,
  subscribeThemeUnsaved,
  THEME_KEY,
  themeUnsaved,
  type ThemePrefs,
  type ThemeTarget,
} from '../web/src/cockpit/theme.js';
import { THEME_TOKENS, TOKEN_GROUPS } from '../web/src/cockpit/tokens.js';

/**
 * The theme's structural guards.
 *
 * `format:check` globs `.ts` and `.tsx` only and there is no stylelint, so **nothing
 * in `npm run check` reads the stylesheets** but this file. Every rule the token
 * layer depends on is therefore asserted here, over the sheets as text — the shape
 * `test/console.test.ts` already uses.
 */

const SHEETS = ['web/src/styles.css', 'web/src/console/console.css', 'web/src/theme.css'];

/** Blank comments to spaces, keeping newlines so line numbers survive. */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = source.indexOf('/*', i);
    if (open < 0) {
      out += source.slice(i);
      return out;
    }
    out += source.slice(i, open);
    const close = source.indexOf('*/', open + 2);
    const end = close < 0 ? source.length : close + 2;
    out += source.slice(open, end).replace(/[^\n]/g, ' ');
    i = end;
  }
}

const DECLARATION = /^\s*--[a-z0-9-]+\s*:/;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

/**
 * The one assertion that makes the sweep finishable, and the one that keeps it
 * finished. No line ranges and no allow-list, so it cannot rot as the sheets grow:
 * a colour may appear on a line that declares a custom property, and nowhere else.
 *
 * A literal at a use site is a colour the operator cannot reach from the Theme
 * section — invisible until someone switches to Light and finds one panel still
 * dark. → docs/spec/17-cockpit.md#tokens
 */
test('no colour literal sits outside a custom-property declaration', () => {
  const offenders: string[] = [];
  for (const sheet of SHEETS) {
    const lines = withoutComments(readFileSync(sheet, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (!LITERAL.test(line) || DECLARATION.test(line)) return;
      offenders.push(`${sheet}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `a colour no theme can reach:\n${offenders.join('\n')}`);
});

function declaredProperties(): Map<string, string> {
  const all = new Map<string, string>();
  for (const sheet of SHEETS) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    for (const match of visible.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (!all.has(match[1]!)) all.set(match[1]!, match[2]!.trim());
    }
  }
  // And the ones a component declares on an element it renders — the row
  // grammar's rails, which the sheet reads and only `PanelRow` can compute. The
  // sweep is after typos, and a property is declared wherever it is declared; a
  // side that only read one of the two would report every one of them missing and
  // teach the next author to add an exception list.
  for (const path of tsxSources()) {
    for (const match of readFileSync(path, 'utf8').matchAll(/'(--[a-z0-9-]+)'\s*:/g)) {
      if (!all.has(match[1]!)) all.set(match[1]!, `declared in ${path}`);
    }
  }
  return all;
}

function tsxSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
  };
  walk('web/src');
  return out;
}

/**
 * A mistyped token is the sweep's real risk: `var(--pnael)` is invalid at
 * computed-value time, so the property falls back to its inherited value or to
 * `currentColor` and the result looks plausible. This caught three live ones when it
 * was written — `--mono`, `--fg` and `--green-line`, each referenced and declared
 * nowhere.
 */
test('every var() names a property something declares', () => {
  const declared = declaredProperties();
  const missing: string[] = [];
  for (const sheet of SHEETS) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    for (const match of visible.matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!declared.has(match[1]!)) missing.push(`${sheet} → ${match[1]}`);
    }
  }
  for (const path of tsxSources()) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      if (!declared.has(match[1]!)) missing.push(`${path} → ${match[1]}`);
    }
    // Names composed at runtime — `var(--sp-${phase})`. The family has to exist even
    // though no single member is spelled out.
    for (const match of source.matchAll(/var\((--[a-z-]+?)-\$\{/g)) {
      const prefix = `${match[1]}-`;
      const found = [...declared.keys()].some((name) => name.startsWith(prefix));
      if (!found) missing.push(`${path} → ${prefix}* (composed)`);
    }
  }
  assert.deepEqual(missing, []);
});

function rootProperties(): Map<string, string> {
  const root = new Map<string, string>();
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    for (const block of visible.matchAll(/^:root\s*\{([\s\S]*?)\n\}/gm)) {
      for (const match of block[1]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        root.set(match[1]!, match[2]!.trim());
      }
    }
  }
  return root;
}

/**
 * Registry against sheets, in both directions, because each way of drifting is
 * silent. A `:root` token missing from the registry is a colour the section cannot
 * reach; a registry entry naming no token is a swatch that changes nothing.
 *
 * The scoped families are deliberately absent from the registry and so are listed
 * here rather than flagged on their entries: `--cn-tone-*`, `--sp-*` and `--rl-*` are
 * declared on `.cn-t-*` / `.sp` / `.rl` as aliases of tokens that *are* themeable, so
 * they follow without being editable themselves. That is a fact about the sheets, not
 * about the tokens.
 */
test('the registry and the :root blocks name the same tokens', () => {
  const root = rootProperties();
  const registry = new Set(THEME_TOKENS.map((t) => t.name));
  const unreachable = [...root.keys()].filter((name) => !registry.has(name));
  const phantom = [...registry].filter((name) => !root.has(name));
  assert.deepEqual(unreachable, [], 'declared on :root but not in the registry, so unthemeable');
  assert.deepEqual(phantom, [], 'in the registry but declared nowhere, so a swatch that does nothing');
  assert.equal(new Set(THEME_TOKENS.map((t) => t.name)).size, THEME_TOKENS.length, 'no duplicate entries');
  for (const token of THEME_TOKENS) assert.ok(TOKEN_GROUPS[token.group], `${token.name} names a real group`);
});

/**
 * The tone aliases are aliases, and nothing else.
 *
 * `.t-*` is the tag's tint vocabulary and `.cn-t-*` the queue rail's, and both work
 * only because a tone block *renames* `:root` tokens
 * rather than holding values. A declaration on `.t-red` shadows an inherited one
 * unconditionally, so a literal, a `color-mix`, or even a second `var()` fallback
 * written there is a colour the Theme section cannot reach *inside* a tone: every
 * tag on the page keeps the sheet's tint while everything around it moves.
 *
 * The literal guard above does not catch it — `color-mix(in srgb, var(--red) 40%,
 * var(--well))` has no hex in it — so this asserts the shape directly: a tone
 * property, and a bare `var()` naming a token `:root` declares.
 * → docs/spec/17-cockpit.md#the-tag
 */
test('every tone alias renames a :root token and holds no value of its own', () => {
  const root = rootProperties();
  const offenders: string[] = [];
  let blocks = 0;
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    for (const block of visible.matchAll(/^\.((?:cn-)?t-[a-z0-9-]+)\s*\{([^}]*)\}/gm)) {
      blocks += 1;
      for (const line of block[2]!.split(';')) {
        const body = line.trim();
        if (body === '') continue;
        const alias = /^(--(?:cn-)?tone[a-z-]*)\s*:\s*var\((--[a-z0-9-]+)\)$/.exec(body);
        if (alias === null) {
          offenders.push(`${sheet} .${block[1]} → ${body}`);
        } else if (!root.has(alias[2]!)) {
          offenders.push(`${sheet} .${block[1]} → ${alias[2]} is declared on no :root`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `a tone that a theme cannot reach:\n${offenders.join('\n')}`);
  // Both families, or the regex stopped matching one of them and asserted nothing.
  assert.ok(blocks >= 10, `only ${blocks} tone blocks found — the sweep is not reaching them`);
});

/**
 * A token's `kind` decides which control edits it and which grammar accepts its
 * value, so a wrong one is doubly silent: the row loses its colour input, and every
 * hex the operator types is refused as malformed. Checking it against the value the
 * sheet actually declares is what makes that loud — the first version of the
 * registry classified `--cn-red` as a *radius*, because the prefix test for
 * `--cn-r` matches it.
 */
test('every token’s kind matches the value its sheet declares', () => {
  const root = rootProperties();
  for (const token of THEME_TOKENS) {
    const value = root.get(token.name);
    assert.ok(value !== undefined, `${token.name} is declared`);
    if (token.kind === 'colour') {
      assert.match(value, /^(?:#[0-9a-fA-F]{3,8}|color-mix\(.*\))$/, `${token.name} is not a colour`);
    } else if (token.kind === 'radius') {
      assert.match(value, /^\d{1,3}(?:px|rem|em|%)?$/, `${token.name} is not a length`);
    } else if (token.kind === 'space') {
      assert.match(value, /^\d{1,3}(?:px|rem|em)( \d{1,3}(?:px|rem|em))?$/, `${token.name} is not an inset`);
    } else if (token.kind === 'metric') {
      assert.match(value, /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em)?$/, `${token.name} is not a metric`);
    } else {
      assert.ok(value.includes(',') || /^[A-Za-z' -]+$/.test(value), `${token.name} is not a font stack`);
    }
    // And the grammar has to accept the sheet's own value, or the row would refuse
    // the very thing it is showing.
    const representative = token.kind === 'colour' ? '#abcdef' : value;
    assert.ok(isTokenValue(token.name, representative), `${token.name} refuses ${representative}`);
  }
});

/**
 * A scrim stays dark on a light theme — that is what a scrim is — so these three are
 * the only colour literals a preset does not owe an answer to.
 */
const THEME_AGNOSTIC = new Set(['--scrim', '--cn-scrim', '--shadow']);

/**
 * What makes five presets maintainable: add a core token and every preset fails
 * until it has an answer.
 *
 * Only the *literals* are required. A token declared on `:root` as a `color-mix` of
 * the core follows on its own, which is the whole leverage of the derived tier — and
 * a preset may still pin one if the mix reads wrong on it.
 *
 * A preset that simply omits a literal inherits Dark's, which on Light is a colour
 * nobody chose and reads as a rendering bug rather than as a missing line of CSS.
 */
/**
 * Every `:root` token whose value is a bare literal. Derived by rule from the sheet
 * rather than listed, so adding a core token adds it to what every preset — and
 * paper — owes an answer to.
 */
function requiredLiterals(): string[] {
  const required = [...rootProperties()]
    .filter(([name, value]) => value.startsWith('#') && !THEME_AGNOSTIC.has(name))
    .map(([name]) => name);
  assert.ok(required.length > 50, `only ${required.length} required tokens, too few to be the real set`);
  return required;
}

test('every preset answers every literal colour token', () => {
  const required = requiredLiterals();

  const sheet = withoutComments(readFileSync('web/src/theme.css', 'utf8'));
  const blocks = new Map<string, Set<string>>();
  for (const block of sheet.matchAll(/html\[data-theme='([a-z-]+)'\][\s\S]*?\{([\s\S]*?)\n\}/g)) {
    blocks.set(block[1]!, new Set([...block[2]!.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!)));
  }

  // Dark is `:root` itself and correctly has no block — that is what makes it the
  // default with no second copy of the palette to drift.
  const expected = PRESETS.filter((p) => p.id !== 'dark').map((p) => p.id);
  assert.deepEqual([...blocks.keys()].sort(), [...expected].sort());

  for (const [preset, declared] of blocks) {
    const missing = required.filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `${preset} leaves these on the Dark value: ${missing.join(', ')}`);
  }
});

/**
 * Paper owes every literal an answer too.
 *
 * The print block declares its tokens **on** `#print-sheet`, and a declaration
 * targeting an element beats any inherited value — including the inline one a theme
 * writes on `<html>`. That is the whole mechanism by which the theme does not reach
 * paper, and it only holds for tokens the block actually restates. Restating the
 * greys was enough while every preset was dark; with Monokai or Dracula live, an
 * unrestated warm tint prints as a dark smudge on white.
 */
test('the print sheet answers every literal colour token', () => {
  const sheet = withoutComments(readFileSync('web/src/styles.css', 'utf8'));
  // Anchored on the newline and its two spaces, because `body.printing #print-sheet`
  // sits above the rule that carries the tokens and would otherwise match first.
  const block = /\n {2}#print-sheet \{([\s\S]*?)\n {2}\}/.exec(sheet.slice(sheet.indexOf('@media print')));
  assert.ok(block, 'the print block is where this test looks for it');
  const declared = new Set([...block[1]!.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const missing = requiredLiterals().filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `these reach paper from whatever theme is live: ${missing.join(', ')}`);
});

/**
 * The four values a preview card draws. Kept here rather than inferred, because the
 * card's honesty is the thing being asserted.
 */
const SWATCH_TOKENS = ['--bg', '--panel', '--text', '--accent'];

/**
 * Dark's preview card must show Dark.
 *
 * Dark has no theme block because it is `:root`, and that is right — but a card reads
 * its swatches through `[data-theme-swatch]`, so with no rule to match, the Dark card
 * inherited whatever theme was live and drew Monokai's colours while offering Dark.
 * The one card that has to be honest about the default was the one lying about it.
 *
 * So `theme.css` carries the four swatch values for Dark, and this holds them against
 * `:root` — the duplication is real and this is what stops it drifting.
 */
test('the Dark preview card draws :root, not whatever theme is live', () => {
  const root = rootProperties();
  const sheet = withoutComments(readFileSync('web/src/theme.css', 'utf8'));
  const block = /\[data-theme-swatch='dark'\]\s*\{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(block, 'theme.css must carry the Dark card its own swatch values');
  const declared = new Map([...block[1]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  assert.deepEqual([...declared.keys()].sort(), [...SWATCH_TOKENS].sort());
  for (const token of SWATCH_TOKENS) {
    assert.equal(declared.get(token), root.get(token), `${token} has drifted from :root`);
  }
});

/**
 * `theme.css` must never target an element, only the root. In particular it must not
 * name `#print-sheet`: paper keeps its own palette *because* that block declares
 * tokens on the print element itself, and a declaration on an element beats any
 * inherited value — including the inline one a theme writes on `<html>`. Keeping this
 * file free of element selectors is what makes "the theme does not reach print" true
 * by construction rather than by care.
 */
test('theme.css declares tokens and selects nothing else', () => {
  const sheet = withoutComments(readFileSync('web/src/theme.css', 'utf8'));
  // Each selector is the run of text between the previous block's close and this
  // block's open — matched that way rather than from the line start, because a
  // blanked comment above a rule is whitespace and would otherwise be swallowed
  // into the selector along with the `}` before it.
  const selectors = sheet
    .split('}')
    .map((chunk) => chunk.slice(0, chunk.indexOf('{')))
    .filter((chunk, index, all) => index < all.length - 1)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
  assert.ok(selectors.length > 0);
  for (const selector of selectors) {
    for (const part of selector.split(',')) {
      const one = part.trim();
      if (one === '') continue;
      assert.match(
        one,
        /^(?:html\[data-theme='[a-z-]+'\]|\[data-theme-swatch='[a-z-]+'\])$/,
        `theme.css must only select the themed root, not ${one}`,
      );
    }
  }
  assert.doesNotMatch(sheet, /print-sheet/, 'the theme must not reach paper');
});

/**
 * The boot script in `index.html` is a second implementation of "apply", which is the
 * cost of having the theme up before the first paint. What contains it is that it
 * knows one thing — the key — so this holds that one thing in step. Renaming
 * `THEME_KEY` otherwise leaves the script reading a key nothing writes, and the only
 * symptom is a flash of dark that nobody can attribute.
 */
test('the pre-paint script in index.html reads the key theme.ts writes', () => {
  const html = readFileSync('web/index.html', 'utf8');
  assert.ok(html.includes(`'${THEME_KEY}'`), `index.html does not name ${THEME_KEY}`);
  assert.match(html, /<script>[\s\S]*localStorage[\s\S]*<\/script>/, 'the script must be classic and inline');
  assert.ok(
    html.indexOf('<script>') < html.indexOf('type="module"'),
    'it must parse before the module that renders the app',
  );
});

test('an unreadable stored theme is the default rather than a throw', () => {
  for (const raw of [null, '', '{', 'null', '[]', '3', '"dark"', '{"overrides":3}', '{"overrides":[]}']) {
    const prefs = readThemePrefs(raw);
    assert.equal(prefs.preset, 'dark', `${raw} should read as the default preset`);
    assert.deepEqual(prefs.overrides, {});
  }
});

test('an unknown preset falls back to Dark and keeps the overrides', () => {
  const prefs = readThemePrefs('{"preset":"vaporwave","overrides":{"--bg":"#123456"}}');
  assert.equal(prefs.preset, 'dark');
  // Landing on Dark with the edits intact is recoverable; a wiped theme is not.
  assert.deepEqual(prefs.overrides, { '--bg': '#123456' });
});

test('an override is dropped unless it names a token and holds a value of its kind', () => {
  const prefs = readThemePrefs(
    JSON.stringify({
      preset: 'light',
      overrides: {
        '--bg': '#101010',
        '--r-md': '4px',
        '--font-mono': 'Berkeley Mono, monospace',
        '--scrim': '#00000099',
        '--gone': '#ffffff',
        '--panel': 'url(https://example.test/x.png)',
        '--text': 'red',
        '--r-sm': '99vmax',
        '--font-ui': 'x; background: url(y)',
        '--muted': 42,
      },
    }),
  );
  assert.equal(prefs.preset, 'light');
  assert.deepEqual(prefs.overrides, {
    '--bg': '#101010',
    '--r-md': '4px',
    '--font-mono': 'Berkeley Mono, monospace',
    '--scrim': '#00000099',
  });
});

test('a colour is a hex literal and nothing else', () => {
  for (const good of ['#fff', '#ffff', '#ff00aa', '#ff00aa80']) assert.ok(isTokenValue('--bg', good), good);
  for (const bad of ['red', 'rgb(1,2,3)', 'var(--text)', 'url(x)', '#ff00a', '']) {
    assert.equal(isTokenValue('--bg', bad), false, bad);
  }
});

function stub(): ThemeTarget & { props: Map<string, string>; attr: string | null } {
  const props = new Map<string, string>();
  const target = {
    props,
    attr: null as string | null,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
    },
    setAttribute: (_name: string, value: string) => void (target.attr = value),
    removeAttribute: () => void (target.attr = null),
  };
  return target;
}

test('the default preset removes the attribute rather than spelling itself out', () => {
  const target = stub();
  target.attr = 'monokai';
  applyTheme({ preset: 'dark', overrides: {} }, target);
  assert.equal(target.attr, null, 'one spelling per theme, as placeQuery omits defaults');
  applyTheme({ preset: 'light', overrides: {} }, target);
  assert.equal(target.attr, 'light');
});

test('applying a theme clears the tokens it no longer overrides', () => {
  const target = stub();
  applyTheme({ preset: 'dark', overrides: { '--bg': '#010203', '--text': '#fefefe' } }, target);
  assert.deepEqual(
    [...target.props],
    [
      ['--bg', '#010203'],
      ['--text', '#fefefe'],
    ],
  );
  // The bug this guards is a one-way live preview: tracking only what was set last
  // time would leave a reverted edit standing on the element.
  applyTheme({ preset: 'dark', overrides: { '--bg': '#010203' } }, target);
  assert.deepEqual([...target.props], [['--bg', '#010203']]);
});

test('a refused value is not written, so a half-typed hex cannot blank the cockpit', () => {
  const target = stub();
  applyTheme({ preset: 'dark', overrides: { '--bg': '#12' } } as ThemePrefs, target);
  assert.deepEqual([...target.props], []);
  applyToken('--bg', '#abcdef', target);
  assert.deepEqual([...target.props], [['--bg', '#abcdef']]);
  applyToken('--bg', null, target);
  assert.deepEqual([...target.props], []);
});

/**
 * Every rule block in the two sheets, as `{selector, declarations}`.
 *
 * Innermost-first, so a block inside `@media` is read and its wrapper is not — which
 * is what the two sweeps below want: a nested copy of the head row is still a copy.
 */
function ruleBlocks(sheet: string): Array<{ selector: string; declarations: Map<string, string> }> {
  const out: Array<{ selector: string; declarations: Map<string, string> }> = [];
  for (const block of withoutComments(readFileSync(sheet, 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1]!
      .trim()
      .split(/\s*\n\s*/)
      .join(' ')
      .trim();
    const declarations = new Map<string, string>();
    for (const decl of block[2]!.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) declarations.set(decl[1]!, decl[2]!.trim());
    out.push({ selector, declarations });
  }
  return out;
}

/**
 * The head row is written once.
 *
 * `display: flex; align-items: center; gap: 8px; flex-wrap: wrap` was the most
 * duplicated declaration set in the cockpit — eleven names for one row, differing in
 * nothing but whether they said `center` or `baseline`. Nothing catches that kind of
 * copy: every one of the eleven rendered, and the drift only ever shows up as two
 * head rows a page apart sitting at different heights.
 *
 * Asserted as a shape rather than a name list, so a twelfth cannot be written: a
 * block whose whole content *is* that set belongs to `HeadRow`.
 * → docs/spec/17-cockpit.md#the-frame
 */
test('the head row is one definition, and alignment is the only axis', () => {
  const copies: string[] = [];
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    for (const { selector, declarations } of ruleBlocks(sheet)) {
      if (selector === '.hdr' || selector === '.hdr-base') continue;
      const only = [...declarations.keys()].every((k) => ['display', 'align-items', 'gap', 'flex-wrap'].includes(k));
      if (!only) continue;
      if (declarations.get('display') !== 'flex') continue;
      if (declarations.get('gap') !== '8px' || declarations.get('flex-wrap') !== 'wrap') continue;
      // The two axis values the component offers, and no others: `stretch` on
      // `.sp-ratio` is a row of tiles that share a height, which is a different row.
      const align = declarations.get('align-items');
      if (align !== 'center' && align !== 'baseline') continue;
      copies.push(`${sheet} → ${selector}`);
    }
  }
  assert.deepEqual(copies, [], `a twelfth head row, written out by hand:\n${copies.join('\n')}`);
});

/**
 * The frame takes its corner and its inset from its family's step, and from nowhere
 * else.
 *
 * A radius literal is the same failure a colour literal is, one property over: the
 * `--r-*` ramp is what the Theme section's Corners rows move, so a hard `7px` on a
 * card is a corner no operator setting can reach — and the cockpit had six of them.
 * The padding is the other half: five insets between 6px 8px and 14px 16px with
 * nothing choosing between them is why density is a named step now.
 * → docs/spec/17-cockpit.md#the-frame
 */
test('the frame draws its corner and its inset through tokens', () => {
  const root = rootProperties();
  const offenders: string[] = [];
  let seen = 0;
  for (const { selector, declarations } of ruleBlocks('web/src/styles.css')) {
    if (!/^\.pl(-[a-z]+)?$/.test(selector)) continue;
    seen += 1;
    for (const property of ['border-radius', 'padding']) {
      const value = declarations.get(property);
      if (value === undefined) continue;
      const named = /^var\((--[a-z0-9-]+)\)$/.exec(value);
      if (named === null) offenders.push(`${selector} → ${property}: ${value}`);
      else if (!root.has(named[1]!)) offenders.push(`${selector} → ${named[1]} is declared on no :root`);
    }
  }
  assert.deepEqual(offenders, [], `a frame no theme can reshape:\n${offenders.join('\n')}`);
  // The frame and its one inset, or the selector test stopped matching them.
  assert.equal(seen, 2, `only ${seen} frame blocks found — the sweep is not reaching them`);
});

/**
 * The field base is an element rule, which is what lets it reach a control nobody
 * remembered — and the reason it can be one is that its type exclusions sit inside
 * `:where()` and cost no specificity. Written as a plain `input:not(…)` the rule
 * counts (0,1,1) and beats every `.pm-note`-shaped rule in the sheet, so twelve
 * fields silently lose the width, the padding and the mono face their own class
 * gives them. Nothing else in `check` reads a selector.
 * → docs/spec/17-cockpit.md#fields
 */
test('the field base leaves its type exclusions weightless', () => {
  const heavy: string[] = [];
  for (const sheet of SHEETS) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    // The exclusion list itself carries commas, so this reads the *start* of a
    // form-control selector rather than trying to split one off a selector list.
    for (const match of visible.matchAll(/(input|textarea|select):not\(/g)) heavy.push(`${sheet} → ${match[0]}`);
  }
  assert.deepEqual(heavy, [], 'an exclusion outside :where() outranks the classes that size a field');
  const base = withoutComments(readFileSync('web/src/styles.css', 'utf8'));
  assert.ok(base.includes('input:where(:not('), 'the base is still there to be outranked');
});

/**
 * `accent-color` is answered by *container* and never by control, because the two
 * families disagree — `--accent` is orange, `--cn-accent` blue — and an inherited
 * value loses to any declaration. So a rule keyed on the input type does not merely
 * pick the wrong hue in one place: it makes the console's answer unreachable for
 * every tick box inside the console, which is the whole set that surface has.
 * → docs/spec/17-cockpit.md#fields
 */
test('accent-color is inherited from a container, never declared on a control', () => {
  const owners: string[] = [];
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    const lines = withoutComments(readFileSync(sheet, 'utf8')).split('\n');
    let selector = '';
    lines.forEach((line) => {
      const open = /^([^{}]+)\{\s*$/.exec(line);
      if (open) selector = open[1]!.trim();
      else if (/accent-color\s*:/.test(line)) owners.push(`${sheet} → ${selector}`);
    });
  }
  assert.deepEqual(
    owners,
    [
      'web/src/styles.css → body',
      // The one exception, and it is not a family: a met acceptance criterion is
      // green because it is a verdict, not because of the surface it is on.
      'web/src/styles.css → .pm-crit input',
      'web/src/console/console.css → .cn',
    ],
    'the hue belongs to the surface a box lands on',
  );
});

/**
 * The unsaved-theme marker. The section's save bar is the only sentence about an
 * unsaved edit and it does not leave the section, so the flag is what the bar's
 * menu and
 * the Theme tab read (issue #680). Two properties matter and neither is visible at
 * a call site: a change reaches subscribers, and an unchanged write does not — a
 * store that notified on every publish would re-render the whole top bar on every
 * frame of a dragged colour input.
 * → docs/spec/17-cockpit.md#the-section
 */
test('the unsaved-theme flag notifies on a change and only on a change', () => {
  let calls = 0;
  const stop = subscribeThemeUnsaved(() => {
    calls += 1;
  });
  assert.equal(themeUnsaved(), false);

  setThemeUnsaved(true);
  assert.equal(themeUnsaved(), true);
  assert.equal(calls, 1);

  setThemeUnsaved(true);
  assert.equal(calls, 1, 'a publish of the value already held is not a change');

  setThemeUnsaved(false);
  assert.equal(themeUnsaved(), false);
  assert.equal(calls, 2);

  stop();
  setThemeUnsaved(true);
  assert.equal(calls, 2, 'unsubscribing stops the notifications');
  setThemeUnsaved(false);
});

/**
 * The eyebrow ramp, held shut.
 *
 * An uppercase caption over a block, a table's column head, a tile's word above its
 * figure — one thing, and the two sheets drew it at **forty** different
 * font-size/letter-spacing pairs: 11px/0.04em, 11px/0.03em, 11px/0.5px,
 * 10.5px/0.7px, 9.5px/0.14em and on. Nobody chose those apart. Each was a call site
 * answering a question the sheet had never answered once, and it is invisible to
 * every other check the repo runs: the rule is valid, the label renders, and the
 * drift shows only to somebody holding two surfaces up together.
 *
 * The guard is a shape rather than a list of names, so it cannot rot and a
 * forty-first pair cannot be written: **uppercase text that is not in a box takes
 * its size and its tracking from `var(--label-*)` and from nowhere else.** A badge
 * is the deliberate exception and it is one the sweep can see — a border, a padding
 * or a ground is what makes `.tag` — the one shape every chip is now drawn in — a
 * shape of its own, where the type is part of the shape rather than a caption over
 * something. → docs/spec/17-cockpit.md#the-eyebrow
 */
test('uppercase text outside a badge takes its size from the label ramp', () => {
  const offenders: string[] = [];
  let labels = 0;
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    for (const { selector, declarations } of ruleBlocks(sheet)) {
      if (declarations.get('text-transform') !== 'uppercase') continue;
      labels += 1;
      // A box: the type is part of a shape rather than a caption over one.
      const boxed = [...declarations.keys()].some((k) => /^(border|padding|background)/.test(k));
      if (boxed) continue;
      // The shorthand carries the size too, and hides it from a `font-size` lookup.
      const shorthand = /(\d+(?:\.\d+)?(?:px|rem|em))/.exec(declarations.get('font') ?? '');
      const size = declarations.get('font-size') ?? shorthand?.[1];
      for (const [property, value] of [
        ['font-size', size],
        ['letter-spacing', declarations.get('letter-spacing')],
      ] as const) {
        if (value === undefined) continue;
        if (!/^var\(--label-[a-z-]+\)$/.test(value)) offenders.push(`${sheet} ${selector} → ${property}: ${value}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a label size nobody chose:\n${offenders.join('\n')}`);
  // A canary on the sweep itself, not a floor on the sheets: it fails if `ruleBlocks`
  // stops parsing or the `text-transform` lookup stops matching, which would make the
  // assertion above vacuously true. The number is deliberately well under the count —
  // it was twenty-odd while every badge family declared its own uppercase, and folding
  // them into the one tag is exactly the kind of change that should not have to move a
  // threshold. → docs/spec/17-cockpit.md#the-tag
  assert.ok(labels > 5, `only ${labels} uppercase rules found — the sweep is not reaching them`);
});
