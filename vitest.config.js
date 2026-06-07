const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 5000,
    hookTimeout: 5000,
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.js']
    }
  }
});
