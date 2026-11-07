import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy JMAP to the local Stalwart so the app always uses same-origin URLs, exactly like production.
const stalwart = process.env.JMAP_URL ?? 'http://localhost:8080';
const signup = process.env.SIGNUP_URL ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  // Same paths the production reverse proxy sends to the mail server: JMAP, OAuth and its sign-in page.
  server: {
    proxy: {
      // Public sign-up service (signup/), only when it's running.
      '/api/signup': signup, '/api/username-available': signup, '/api/aliases': signup, '/api/session': signup, '/api/account': signup, '/api/admin': signup, '/api/principal': signup,
      ...Object.fromEntries(['/jmap', '/.well-known', '/login', '/api/auth', '/auth', '/ui-', '/logo', '/dav'].map((p) => [p, stalwart])),
    },
  },
});
