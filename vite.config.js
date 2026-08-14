import { defineConfig } from 'vite';

// dev dependency, not installed on the server. https matters locally because
// getUserMedia needs it on a lan ip.
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
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
}));
