import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// https is not optional here: getUserMedia (voice) is blocked on a plain-http lan ip
export default defineConfig({
  plugins: [basicSsl()],
  build: { outDir: 'dist' },
  server: {
    host: true,
    port: 5173,
    // proxy the api through vite so the phone only has to trust one cert
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
