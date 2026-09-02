import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-firefox/**',
      'node_modules/**',
      'backend/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Vendored, minified OCR runtime assets (Tesseract worker + wasm glue),
      // bundled verbatim into the extension — not our source to lint.
      'extension/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        chrome: 'readonly',
      },
    },
    rules: {
      // TypeScript performs its own undefined-symbol checking.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
