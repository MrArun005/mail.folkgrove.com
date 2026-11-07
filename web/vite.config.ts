import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy JMAP to the local Stalwart so the app always uses same-origin URLs, exactly like production.
const stalwart = process.env.JMAP_URL ?? 'http://localhost:8080';
export default defineConfig({
  plugins: [react()],
  // Same paths the production reverse proxy sends to the mail server: JMAP, OAuth and its sign-in page.
  server: { proxy: Object.fromEntries(['/jmap', '/.well-known', '/login', '/api/auth', '/auth', '/ui-', '/logo'].map((p) => [p, stalwart])) },
});
