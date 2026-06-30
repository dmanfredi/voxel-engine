import { defineConfig } from 'vite';

export default defineConfig({
	// Relative base so the build can be served from any subfolder
	base: './',
	server: {
		hmr: false,
	},
});
