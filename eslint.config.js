// Flat config, dependency-light on purpose. no-undef stays off because
// the Workers runtime globals (fetch, Response, AbortSignal, TextEncoder)
// would otherwise need a maintained globals list that adds nothing here.
export default [
  {
    ignores: ["dist/", ".wrangler/", "node_modules/"],
  },
  {
    files: ["src/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "off",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
];
