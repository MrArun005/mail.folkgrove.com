import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy JMAP to the local Stalwart so the app always uses same-origin URLs, exactly like production.
const stalwart = process.env.JMAP_URL ?? 'http://localhost:8080';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/jmap': stalwart, '/.well-known/jmap': stalwart } },
});
