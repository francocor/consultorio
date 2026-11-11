import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'config',
    environment: 'node',
    include: ['eslint/**/*.test.js'],
  },
});
