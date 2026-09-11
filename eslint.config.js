const { defineConfig } = require('eslint/config');

module.exports = defineConfig([
  {
    files: ['blink/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        // Node 18+ built-in fetch
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URLSearchParams: 'readonly',
        // WebSocket (available with --experimental-websocket or Node 22+)
        WebSocket: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      eqeqeq: ['error', 'always'],
      curly: ['warn', 'multi-line'],
      'no-throw-literal': 'error',
      'no-var': 'error',
    },
  },
]);
