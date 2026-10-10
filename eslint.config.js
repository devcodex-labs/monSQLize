/**
 * ESLint v9 Flat Config
 * Migrated from .eslintrc.js.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

const javascriptFiles = ['**/*.js', '**/*.cjs', '**/*.mjs'];
const typescriptFiles = ['src/**/*.ts', 'src/**/*.mts', 'types/**/*.d.ts', 'test/**/*.ts', 'examples/**/*.ts', 'website/**/*.ts', 'website/**/*.tsx'];
const nodeGlobals = {
    __dirname: 'readonly',
    __filename: 'readonly',
    Buffer: 'readonly',
    console: 'readonly',
    process: 'readonly',
    require: 'readonly',
    module: 'readonly',
    exports: 'writable',
    global: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    URL: 'readonly',
    queueMicrotask: 'readonly',
};

module.exports = [
    // ESLint recommended rules.
    {
        ...js.configs.recommended,
        files: javascriptFiles,
    },

    // TypeScript parser and recommended syntax-aware rules (type correctness remains owned by tsc/tsd).
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: typescriptFiles,
    })),

    // Global config.
    {
        files: javascriptFiles,
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: nodeGlobals,
        },
        rules: {
            // Code style.
            'indent': 'off',  // Indentation is currently handled outside ESLint.
            'quotes': ['warn', 'single', { avoidEscape: true }],
            'semi': ['error', 'always'],
            'no-trailing-spaces': 'warn',

            // Best practices.
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            'no-console': 'off', // Console output is allowed for logger adapters and scripts.
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'off',

            // ES6+
            'prefer-const': 'warn',
            'no-var': 'warn',
            'object-shorthand': 'warn',
            'prefer-arrow-callback': 'off',

            // Async.
            'require-await': 'warn',

            // Error prevention.
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
        }
    },

    // TypeScript project files.
    {
        files: typescriptFiles,
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
            globals: nodeGlobals,
        },
        rules: {
            'indent': 'off',
            'quotes': ['warn', 'single', { avoidEscape: true }],
            'semi': ['error', 'always'],
            'no-trailing-spaces': 'warn',
            'no-console': 'off',
            'prefer-const': 'warn',
            'no-var': 'warn',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },

    // ESM entrypoint override.
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
        }
    },

    // Test file override.
    {
        files: ['test/**/*.js', '**/*.test.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                before: 'readonly',
                after: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                expect: 'readonly',
            }
        }
    },

    // Ignored files.
    {
        ignores: [
            'dist/**',
            '.devcodex/**',
            'node_modules/',
            'coverage/',
            'lib/',
            'old/',
            'reports/',
            'index.mjs',
            '*.min.js',
            '.nyc_output/',
            'website/dist/',
            'website/.vitepress/dist/',
            '.generated/',
        ]
    }
];

