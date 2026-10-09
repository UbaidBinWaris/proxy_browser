import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.deploy/**', 'app/webapp/.next/**', 'app/webapp/node_modules/**', 'out/**', 'dist/**', 'release/**', 'release-update-smoke/**', 'node_modules/**', 'data/**', 'build/browsers/**', 'build/webkit-libs/**', '.remember/**', '.serena/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
