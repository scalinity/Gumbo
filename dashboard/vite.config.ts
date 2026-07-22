import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // IPv4 pin: an unpinned Vite binds ::1-only on this machine, invisible to every
    // 127.0.0.1 probe (the daemon's ensure-server and the shell's launcher) — the daemon
    // then spawned a duplicate on 5174 every boot. WKWebView's localhost resolves either.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8737',
      '/files': 'http://localhost:8737',
    },
  },
});
