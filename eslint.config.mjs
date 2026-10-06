// ESLint flat config — backend repo.
// Own config of this repo; intentionally duplicated (not shared) with frontend.
// Strict TypeScript rules; explicit `any` is forbidden unless justified with:
//   // justificado: <motivo>
//   // eslint-disable-next-line @typescript-eslint/no-explicit-any
// (reportUnusedDisableDirectives ensures stale disables fail lint.)
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // NestJS modules/controllers are decorated (idiomatic) empty classes.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // Test files interact with untyped boundaries (e.g. supertest/Nest
    // `getHttpServer()` returns `any`). Keep the explicit-`any` ban, but do
    // not fail on implicit `any` flowing in from third-party test helpers.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
