// Browser tests for the things unit tests can't see: Back and links, the phone drawer, swipe, drag to a folder, Undo.
// They drive the real app against the local mail server (node deploy/dev-setup.mjs), like the integration tests.
//   npm run e2e            (starts the dev server if it isn't running)
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts', // not *.spec.ts / *.test.ts: those belong to vitest
  workers: 1,            // one mailbox, shared: tests take turns and put back what they move
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'off' },
  webServer: { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: 'phone.e2e.ts' },
    // A phone's size and touch, in Chromium (the browser CI installs).
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: 'phone.e2e.ts' },
  ],
});
