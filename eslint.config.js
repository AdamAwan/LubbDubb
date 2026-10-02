import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const SPEC = '→ docs/spec/34-usage-metrics.md#a-control-that-is-not-a-button';

const CLICKABLE = [
  {
    selector: "JSXAttribute[name.name='role'][value.value='button']",
    message: `A role="button" is a button nobody named a usage event for. Draw it with BareButton, or SvgButton inside an <svg> (web/src/components/button.tsx). ${SPEC}`,
  },
  {
    selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='onClick']",
    message: `An onClick on a plain element is a control nobody named a usage event for. Draw it with Button or BareButton (web/src/components/button.tsx), which require one. ${SPEC}`,
  },
  {
    selector: ":matches(ConditionalExpression, LogicalExpression, VariableDeclarator) > Literal[value='button']",
    message: `A tag chosen at runtime draws a <button> the element rule cannot see. Render BareButton on that branch instead. ${SPEC}`,
  },
];

const FOLD = {
  selector: "JSXOpeningElement[name.name='details']",
  message:
    'A <details> is a fold drawn by hand, with its own caret, its own look and no usage event. Use Collapsible or FoldToggle (web/src/components/collapsible.tsx). → docs/spec/17-cockpit.md#the-fold',
};

const STYLED_AS_BUTTON = {
  selector: "CallExpression[callee.name='buttonClass']",
  message: `Only the button components wear buttonClass — anything else wearing it is a control that logs nothing. Use Button, AsyncButton, ConfirmButton or DesktopLink. ${SPEC}`,
};

export default tseslint.config(
  {
    // `.claude/worktrees/` holds sibling checkouts of this same repo — linting them
    // duplicates every finding under a path that is not the one to fix, and buries a
    // real error in thousands of copies.
    ignores: [
      'dist/**',
      '.testbuild/**',
      'web/dist/**',
      'coverage/**',
      'node_modules/**',
      '.lubbdubb/**',
      '.claude/worktrees/**',
    ],
  },

  // Base JS + TypeScript recommended rules for all source.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node/server + shared TypeScript.
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The harness leans on structural/`unknown` seams and validated JSON; keep `any` a warning, not a blocker.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Shipped standalone Node helper scripts (e.g. the status-line capture helper
  // invoked as `node <path>`) — plain `.mjs`, so they need Node globals too.
  {
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // React web SPA.
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The SPA uses the automatic JSX runtime — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react/forbid-elements': [
        'error',
        {
          forbid: [
            {
              element: 'button',
              message:
                'Draw it with Button, AsyncButton or BareButton (web/src/components/button.tsx), which require a `usage` event. → docs/spec/34-usage-metrics.md#every-button-names-its-event',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...CLICKABLE, STYLED_AS_BUTTON, FOLD] },
  },
  {
    files: [
      'web/src/components/AsyncButton.tsx',
      'web/src/components/ConfirmButton.tsx',
      'web/src/components/DesktopLink.tsx',
    ],
    rules: { 'no-restricted-syntax': ['error', ...CLICKABLE, FOLD] },
  },
  {
    files: ['web/src/components/button.tsx'],
    rules: { 'react/forbid-elements': 'off', 'no-restricted-syntax': 'off' },
  },

  // Complexity limits. Existing breaches are frozen in eslint-suppressions.json;
  // fix one and run `npm run lint:prune` so the count only goes down.
  {
    files: ['src/**/*.ts', 'web/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },

  // Turn off any stylistic rules that would fight Prettier. Must stay last.
  prettier,
);
