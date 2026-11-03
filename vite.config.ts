import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';
import { buildSync } from 'esbuild';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'build-extension-scripts',
      closeBundle() {
        console.log('[Build] Packaging content-script as standalone IIFE bundle...');
        buildSync({
          entryPoints: [resolve(__dirname, 'src/content/content-script.ts')],
          bundle: true,
          outfile: resolve(__dirname, 'dist/content-script.js'),
          format: 'iife',
          target: 'es2022',
        });

        const manifest = JSON.parse(fs.readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8'));
        manifest.background = {
          service_worker: 'service-worker.js',
          type: 'module',
        };
        manifest.content_scripts = [
          {
            matches: ['<all_urls>'],
            js: ['content-script.js'],
            run_at: 'document_idle',
          },
        ];
        if (!fs.existsSync(resolve(__dirname, 'dist'))) {
          fs.mkdirSync(resolve(__dirname, 'dist'));
        }
        fs.writeFileSync(
          resolve(__dirname, 'dist/manifest.json'),
          JSON.stringify(manifest, null, 2)
        );
        console.log('[Build] Extension manifest and content-script ready.');
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker') return 'service-worker.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
