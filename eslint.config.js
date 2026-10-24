import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'panel/public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      // `_x` marks a parameter that a callback signature forces on us.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test doubles read and build arbitrary JSON; typing every fixture adds noise, not safety.
    files: ['**/__tests__/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['gate/**/*.ts', 'agent/**/*.ts', 'tray/**/*.js', 'e2e/**/*.mjs', 'tools/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'agent/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['panel/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
    languageOptions: { globals: globals.browser },
  },
);
