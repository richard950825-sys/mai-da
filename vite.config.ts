import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const { PORT = '8788' } = loadEnv(mode, process.cwd(), '');
  return {
    server: {
      host: '127.0.0.1',
      port: 5178,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${PORT}` },
    },
    build: { sourcemap: false },
  };
});
