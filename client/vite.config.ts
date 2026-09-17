import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    rollupOptions: {
      output: {
        // Third-party code changes far less often than app code, so it is split
        // into stable chunks the browser can keep cached across deploys. Charts
        // are their own chunk: only the dashboard and analytics pages need them.
        manualChunks(id) {
          // Rollup pulls a manual chunk's UNASSIGNED dependencies into that chunk.
          // `clsx` is used by both the app shell (cn) and recharts, so left alone it
          // landed in the charts chunk and made the shell preload all of recharts.
          // Pin it, and Rollup's CommonJS helper, to the chunk that always loads.
          // Both are leaf modules, so pinning them drags nothing else along.
          if (id === '\0commonjsHelpers.js' || /[\\/]node_modules[\\/]clsx[\\/]/.test(id)) return 'vendor-react';
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor)[\\/]/.test(id)) return 'vendor-charts';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'vendor-react';
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) return 'vendor-radix';
          if (/[\\/]node_modules[\\/](@tanstack|axios)[\\/]/.test(id)) return 'vendor-data';
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/.test(id)) return 'vendor-forms';
          if (/[\\/]node_modules[\\/]date-fns[\\/]/.test(id)) return 'vendor-dates';
          return undefined;
        },
      },
    },
  },
  server: {
    allowedHosts: ['iodize-travel-pregame.ngrok-free.dev'],
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
