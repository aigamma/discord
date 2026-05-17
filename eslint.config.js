// Flat ESLint config. Keeps rules tight on correctness — unused vars,
// undef references, no-fallthrough — but skips stylistic nags (the project
// has a coherent voice across modules and no one is enforcing tabs vs
// spaces from a config file).

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'dist/**', '.netlify/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-useless-rename': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
      eqeqeq: ['error', 'smart'],
    },
  },
];
