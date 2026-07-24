import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'web/dist/**', 'coverage/**', 'node_modules/**', '.lubbdubb/**'],
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
    },
  },

  // Turn off any stylistic rules that would fight Prettier. Must stay last.
  prettier,
);
