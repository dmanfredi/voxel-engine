// @ts-check

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
	{
		ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'],
	},

	// main app
	{
		files: ['src/**/*.{ts,tsx,mts,cts}'],
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},

	// misc files
	{
		files: ['scripts/**/*.{ts,js,mjs,cjs}'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},

	eslint.configs.recommended,

	// Strict + type-aware + stylistic TS rules
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,

	// Tell typescript-eslint how to get type info (typed linting)
	{
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: __dirname,
			},
		},
	}
);
