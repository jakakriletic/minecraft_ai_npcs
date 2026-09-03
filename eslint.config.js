// eslint.config.js
import globals from "globals";
import pluginJs from "@eslint/js";
import noFloatingPromise from "eslint-plugin-no-floating-promise";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["bots/**"],
  },
  // First, import the recommended configuration
  pluginJs.configs.recommended,

  // Then override or customize specific rules
  {
    plugins: {
      "no-floating-promise": noFloatingPromise,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",              // Disallow the use of undeclared variables or functions.
      "semi": "off",                    // The inherited codebase intentionally uses mixed semicolon style.
      "curly": "off",                   // Do not enforce the use of curly braces around blocks of code.
      "no-unused-vars": "off",          // Disable warnings for unused variables.
      "no-unreachable": "off",          // Disable warnings for unreachable code.
      "require-await": "off",           // Public async APIs may intentionally return immediately.
      "no-floating-promise/no-floating-promise": "error", // Disallow Promises without error handling or awaiting
    },
  },
];
