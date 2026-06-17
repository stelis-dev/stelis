import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/', '**/node_modules/', '**/build/', '**/*.move'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error',
      'no-console': 'warn',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@mysten/sui/jsonRpc',
              message:
                'SuiJsonRpcClient is banned. Use SuiGrpcClient from @mysten/sui/grpc instead.',
            },
          ],
          patterns: [
            {
              group: ['@mysten/sui/jsonRpc*'],
              message:
                'SuiJsonRpcClient is banned. Use SuiGrpcClient from @mysten/sui/grpc instead.',
            },
          ],
        },
      ],
    },
  },
);
