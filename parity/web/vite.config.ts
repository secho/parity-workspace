import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiOrigin = process.env.PARITY_API_ORIGIN ?? 'http://localhost:3200';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
    },
  },
});
