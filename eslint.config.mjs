// ESLint flat config for the whole monorepo (server, client, scripts).
//
// Scope is deliberate: rules that catch real defects (hooks misuse, unused
// code, unsafe equality, TypeScript mistakes) are errors. Formatting is left to
// Prettier and is not linted, so adopting the linter did not mean rewriting
// working code. Tighten rules one at a time, fixing the code as they go in.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // `.claude/**` matters: the desktop app creates git worktrees under
    // `.claude/worktrees/`, which puts a full second copy of the repository
    // inside it. Without this, `npm run lint` from the repository root lints
    // that copy too - and because the paths are nested deeper, the
    // path-specific overrides below (node globals for `scripts/*.mjs`, say) no
    // longer match, so the same files fail with ~150 phantom `no-undef`
    // errors. Nothing under `.claude/` is source.
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'coverage/**',
      'server/uploads/**',
      '.claude/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      // Unused parameters that are positional placeholders are prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // `==` only where it is the intended null-or-undefined check.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Browser code: React hooks must be called unconditionally and in order.
  {
    files: ['client/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Node code: the API, its scripts, and build tooling config files.
  {
    files: ['server/**/*.ts', 'scripts/**/*.{js,mjs}', 'client/scripts/**/*.{js,mjs}', '*.{js,mjs}', 'client/*.{js,mjs,ts,cjs}'],
    languageOptions: { globals: globals.node },
  },

  // Tooling configs that load plugins with require() (Tailwind's is CommonJS).
  {
    files: ['client/tailwind.config.js', '**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
