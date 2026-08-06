// ESLint 9 flat config —— 由原 `.eslintrc.js` (eslint-config-alloy v3) 迁移而来。
// 由于 alloy 仅兼容 ESLint 8，这里改用 `typescript-eslint` + `eslint-plugin-react` 系列插件复刻
// 等价规则集，并补充更适合本仓库 (Electron + React 19 + Vite + NodeNext TS) 的覆盖范围。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'

export default tseslint.config(
  {
    // 全局忽略：构建产物、依赖目录、生成文件、构建脚本（脚本里有 process.exit 风格代码）。
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.min.js',
      '**/vendor/**',
      'scripts/**',
      // Prettier / Stylelint / Vite 等配置文件由各自工具处理，避免与 eslint 规则冲突
      'prettier.config.mjs',
      'stylelint.config.mjs',
      'eslint.config.mjs',
      'apps/desktop/vite.config.ts',
      'apps/desktop/postcss.config.*',
      'apps/desktop/tailwind.config.*',
      // monorepo 内部的预构建 symlink 区域
      'apps/desktop/node_modules/**',
      'packages/*/node_modules/**'
    ]
  },

  // —— 基础推荐规则集 ——
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // —— 全局 JS/TS 规则覆盖 ——
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022
      }
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      import: importPlugin
    },
    settings: {
      react: { version: 'detect' },
      'import/resolver': {
        typescript: {
          project: ['apps/*/tsconfig.json', 'apps/*/tsconfig.*.json', 'packages/*/tsconfig.json']
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']
        }
      }
    },
    rules: {
      // —— 保留原 `.eslintrc.js` 中的 import 规则 ——
      'import/order': 'error',
      'import/first': 'error',
      'import/no-mutable-exports': 'error',
      'import/no-unresolved': 'off',
      'import/default': 'off',
      // —— 保留原 react 规则覆写 ——
      'react/iframe-missing-sandbox': 'off',

      // —— React 19 + Vite + TS：不需要 PropTypes / React in scope ——
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'off',

      // —— React Hooks ——
      ...reactHooks.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // —— JSX A11y ——
      ...jsxA11y.configs.recommended.rules,
      // HMR 友好的宽松规则
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // —— 通用代码质量 ——
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-debugger': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },

  // —— TypeScript 专属补充 ——
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    rules: {
      'no-undef': 'off' // TS 自行处理
    }
  },

  // —— 测试文件放宽 ——
  {
    files: ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}', '**/test/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.vitest
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'off'
    }
  },

  // —— 配置文件可执行任意 require ——
  {
    files: ['**/*.config.{js,mjs,cjs,ts,mts}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off'
    }
  }
)
