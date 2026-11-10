// Browser tests for the things unit tests can't see: Back and links, the phone drawer, swipe, drag to a folder, Undo.
// They drive the real app against the local mail server (node deploy/dev-setup.mjs), like the integration tests.
//   npm run e2e            (starts the dev server if it isn't running)
import { defineConfig, devices } from '@playwright/test';

// E2E_PORT: another port for a second checkout's dev server (dev-setup.mjs lets 5173-5179 sign in).
const PORT = process.env.E2E_PORT ?? '5173';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts', // not *.spec.ts / *.test.ts: those belong to vitest
  workers: 1,            // one mailbox, shared: tests take turns and put back what they move
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000, // room for one sign-in retry (helpers.ts)
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off' },
  webServer: { command: `npm run dev -- --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 60_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: 'phone.e2e.ts' },
    // A phone's size and touch, in Chromium (the browser CI installs).
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: 'phone.e2e.ts' },
    // Other engines, on request (E2E_ALL=1; CI sets it): Firefox, and WebKit, the engine inside Safari and every
    // iPhone browser. Desktop tests only: touch input here is sent through Chromium's own protocol.
    ...(process.env.E2E_ALL ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } }, testIgnore: 'phone.e2e.ts' },
      { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }, testIgnore: 'phone.e2e.ts' },
    ] : []),
  ],
});
