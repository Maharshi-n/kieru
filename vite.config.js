import { defineConfig } from 'vite';

// basic-ssl is a dev dependency and isn't installed on the server, so only load it
// when actually serving. https matters locally because getUserMedia needs it on a lan ip.
const ssl = async () => {
  try {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
    return [basicSsl()];
  } catch {
    return [];
  }
};

export default defineConfig(async ({ command }) => ({
  plugins: command === 'serve' ? await ssl() : [],
  build: { outDir: 'dist' },
  server: {
    host: true,
    port: 5173,
    // proxy the api through vite so the phone only has to trust one cert
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
}));
