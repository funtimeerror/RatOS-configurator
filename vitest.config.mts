import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	test: {
		dir: '__tests__',
		environment: 'node',
		globals: true,
		globalSetup: './test-setup.ts',
		coverage: {
			enabled: process.env.argv?.includes('--coverage'),
			reporter: ['text', 'json-summary', 'json'],
			reportOnFailure: true,
			include: ['**/*'],
			exclude: ['__tests__/*', '*.*', 'env/*', 'app/**/*', 'components/**/*', 'pages/**/*'],
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './')
		},
	},
});
