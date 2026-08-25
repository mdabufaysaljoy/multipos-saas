import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Honour PORT when the environment assigns one (5173 by default).
    port: Number(process.env.PORT) || 5173,
    // Proxying keeps the browser on one origin, so the refresh-token cookie
    // works without any cross-site cookie configuration in development.
    proxy: {
      '/api': { target: 'http://localhost:4100', changeOrigin: true },
      '/uploads': { target: 'http://localhost:4100', changeOrigin: true },
    },
  },
});
