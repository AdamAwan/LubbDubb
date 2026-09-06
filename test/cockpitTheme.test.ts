import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTheme,
  applyToken,
  isTokenValue,
  PRESET_GROUPS,
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

const SHEETS = ['web/src/styles.css', 'web/src/console/console.css', 'web/src/theme.css'];

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
  assert.ok(blocks >= 10, `only ${blocks} tone blocks found — the sweep is not reaching them`);
});

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
    const representative = token.kind === 'colour' ? '#abcdef' : value;
    assert.ok(isTokenValue(token.name, representative), `${token.name} refuses ${representative}`);
  }
});

const THEME_AGNOSTIC = new Set(['--scrim', '--cn-scrim', '--shadow']);

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

  const expected = PRESETS.filter((p) => p.id !== 'dark').map((p) => p.id);
  assert.deepEqual([...blocks.keys()].sort(), [...expected].sort());

  for (const [preset, declared] of blocks) {
    const missing = required.filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `${preset} leaves these on the Dark value: ${missing.join(', ')}`);
  }
});

test('every preset sits in a picker row, and no row is empty', () => {
  const grounds = new Set(PRESET_GROUPS.map((g) => g.ground));
  assert.equal(grounds.size, PRESET_GROUPS.length, 'no duplicate rows');
  for (const p of PRESETS) assert.ok(grounds.has(p.ground), `${p.id} names a row the picker draws`);
  for (const g of PRESET_GROUPS) {
    assert.ok(
      PRESETS.some((p) => p.ground === g.ground),
      `the ${g.label} row has at least one preset`,
    );
  }
});

test('the print sheet answers every literal colour token', () => {
  const sheet = withoutComments(readFileSync('web/src/styles.css', 'utf8'));
  const block = /\n {2}#print-sheet \{([\s\S]*?)\n {2}\}/.exec(sheet.slice(sheet.indexOf('@media print')));
  assert.ok(block, 'the print block is where this test looks for it');
  const declared = new Set([...block[1]!.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const missing = requiredLiterals().filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `these reach paper from whatever theme is live: ${missing.join(', ')}`);
});

const SWATCH_TOKENS = ['--bg', '--panel', '--text', '--accent'];

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

test('theme.css declares tokens and selects nothing else', () => {
  const sheet = withoutComments(readFileSync('web/src/theme.css', 'utf8'));
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

test('the head row is one definition, and alignment is the only axis', () => {
  const copies: string[] = [];
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    for (const { selector, declarations } of ruleBlocks(sheet)) {
      if (selector === '.hdr' || selector === '.hdr-base') continue;
      const only = [...declarations.keys()].every((k) => ['display', 'align-items', 'gap', 'flex-wrap'].includes(k));
      if (!only) continue;
      if (declarations.get('display') !== 'flex') continue;
      if (declarations.get('gap') !== '8px' || declarations.get('flex-wrap') !== 'wrap') continue;
      const align = declarations.get('align-items');
      if (align !== 'center' && align !== 'baseline') continue;
      copies.push(`${sheet} → ${selector}`);
    }
  }
  assert.deepEqual(copies, [], `a twelfth head row, written out by hand:\n${copies.join('\n')}`);
});

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
  assert.equal(seen, 2, `only ${seen} frame blocks found — the sweep is not reaching them`);
});

test('the field base leaves its type exclusions weightless', () => {
  const heavy: string[] = [];
  for (const sheet of SHEETS) {
    const visible = withoutComments(readFileSync(sheet, 'utf8'));
    for (const match of visible.matchAll(/(input|textarea|select):not\(/g)) heavy.push(`${sheet} → ${match[0]}`);
  }
  assert.deepEqual(heavy, [], 'an exclusion outside :where() outranks the classes that size a field');
  const base = withoutComments(readFileSync('web/src/styles.css', 'utf8'));
  assert.ok(base.includes('input:where(:not('), 'the base is still there to be outranked');
});

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
    ['web/src/styles.css → body', 'web/src/styles.css → .pm-crit input', 'web/src/console/console.css → .cn'],
    'the hue belongs to the surface a box lands on',
  );
});

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

test('uppercase text outside a badge takes its size from the label ramp', () => {
  const offenders: string[] = [];
  let labels = 0;
  for (const sheet of ['web/src/styles.css', 'web/src/console/console.css']) {
    for (const { selector, declarations } of ruleBlocks(sheet)) {
      if (declarations.get('text-transform') !== 'uppercase') continue;
      labels += 1;
      const boxed = [...declarations.keys()].some((k) => /^(border|padding|background)/.test(k));
      if (boxed) continue;
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
  assert.ok(labels > 5, `only ${labels} uppercase rules found — the sweep is not reaching them`);
});
