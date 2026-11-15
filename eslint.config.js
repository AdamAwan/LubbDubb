import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { createRequire } from 'node:module';

// eslint-plugin-react's `detect` calls context.getFilename(), gone in ESLint 10; restore it (and drop the
// package.json override) once the plugin supports ESLint 10.
const REACT_VERSION = createRequire(import.meta.url)('react/package.json').version;

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

// CLAUDE.md sharp edges a selector can see. Each names what to do instead and the spec that says why;
// the one line where a construct is meant to live carries an eslint-disable. → docs/spec/19-development.md#guards
const SERVER_GUARDS = [
  {
    selector: "ArrayExpression > Literal[value='switch'] ~ Literal[value=/^(-C|--force-create)$/]",
    message:
      '`git switch -C` rewinds a branch that already has commits and loses them. Check the ref exists and `switch` to it; reach `switch -c` only for one that does not. → docs/spec/09-execution.md#handing-a-slot-over',
  },
  {
    selector: "ArrayExpression > Literal[value=/^(checkout|worktree)$/] ~ Literal[value='-B']",
    message:
      '`-B` rewinds a branch that already has commits and loses them. Check the ref exists first; only create one that does not, with `-b`. → docs/spec/09-execution.md#handing-a-slot-over',
  },
  {
    selector:
      "CallExpression[callee.name='runGit'] Property[key.name='timeoutMs']:matches([value.value=0], [value.name='Infinity'])",
    message:
      'A git with no deadline is a promise that may never settle, and it stalls the whole cycle silently. A legitimately long subcommand goes in SLOW_SUBCOMMANDS (src/git/gitCli.ts). → docs/spec/09-execution.md#a-git-that-never-exits',
  },
  {
    selector:
      ":matches(Property[key.name='ANTHROPIC_API_KEY'], Property[key.value='ANTHROPIC_API_KEY'], AssignmentExpression > MemberExpression.left[property.name='ANTHROPIC_API_KEY'], AssignmentExpression > MemberExpression.left[property.value='ANTHROPIC_API_KEY'])",
    message:
      'Setting ANTHROPIC_API_KEY moves the whole fleet onto API billing — non-interactive `claude` always uses the key when present. Fix the login instead. → docs/spec/02-configuration.md#secrets',
  },
  {
    selector:
      'TemplateLiteral:has(> TemplateElement[value.raw=/(^|[^\\w])issue:$/]) > TemplateElement[value.raw=/^:(?!comment:)/]',
    message:
      'An issue:<n>:… origin built by hand is in no family, reads `unrecognised` and files its spend under "other". Declare the family in src/issueOrigins.ts and mint the ref through it. → docs/spec/05-dispatcher.md#the-issue-origin-vocabulary',
  },
  {
    selector: 'Literal[value=/^--(session-id|resume)$/]',
    message:
      '`claude` refuses --session-id on an id that already has a transcript, and dies with no stream event. Write the flag through appendSessionFlags (src/agents/agentProtocol.ts), which carries exactly one. → docs/spec/10-agent-runtimes.md#launch-arguments',
  },
];

const UPGRADE_EXIT = {
  selector:
    ":matches(CallExpression[callee.property.name='exit'], BinaryExpression:has(> Identifier[name=/[cC]ode$/])) > Literal[value=75]",
  message:
    'Spell the upgrade exit as UPGRADE_EXIT_CODE (src/selfUpdate/handoff.ts). An exit the supervisor reads as a crash comes back on the old build, looking like a successful upgrade. → docs/spec/21-self-update.md#applying-it',
};

const DEPLOYMENT_CONFIG_IN_TESTS = {
  selector: "CallExpression[callee.name='loadDeploymentConfig']",
  message:
    'loadDeploymentConfig reads lubbdubb.config.json and the env, so a test on it passes or fails by machine. Build the config with loadConfig. → docs/spec/02-configuration.md#two-loaders',
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
      '**/.claude-plugin/types/**',
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

  { files: ['src/**/*.ts'], rules: { 'no-restricted-syntax': ['error', ...SERVER_GUARDS, UPGRADE_EXIT] } },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts', 'web/**/*.{ts,tsx}'],
    ignores: ['src/types/**', 'src/wire/**', 'src/types.ts', 'src/wire.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)src/(types|wire)/|^\\.\\.?/(\\.\\./)*(types|wire)/',
              message:
                'Import the barrel (src/types.ts or src/wire.ts), never a module behind it. → docs/spec/19-development.md',
            },
          ],
        },
      ],
    },
  },
  { files: ['scripts/**/*.ts'], rules: { 'no-restricted-syntax': ['error', UPGRADE_EXIT] } },
  { files: ['test/**/*.ts'], rules: { 'no-restricted-syntax': ['error', DEPLOYMENT_CONFIG_IN_TESTS] } },
  { files: ['test/config.test.ts'], rules: { 'no-restricted-syntax': 'off' } },

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
      react: { version: REACT_VERSION },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      // v7's `recommended` adds the React Compiler rules; adopting them is its own change.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
