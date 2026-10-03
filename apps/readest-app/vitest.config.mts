import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      // The @pdfjs alias from tsconfig only resolves within the app's own
      // source files.  foliate-js/pdf.js lives outside that scope, so Vite
      // needs an explicit alias to reach pdfjs-dist. It points at the real
      // package rather than a copy under `public/`: a module the bundler
      // imports must not be published too, or Tauri embeds it twice (#6368).
      '@pdfjs': path.resolve(__dirname, '../../packages/foliate-js/node_modules/pdfjs-dist/legacy/build'),
      // `js-mdict` is consumed via tsconfig paths from `packages/js-mdict/src/`.
      // Its sources `import 'fflate'` directly — without an alias, vite's
      // import-analysis walks up from the redirected file location and fails
      // to find fflate (it's installed only in this app's node_modules).
      // Pin all `fflate` resolutions to the app's copy to keep js-mdict
      // self-contained at the source-tree level.
      fflate: path.resolve(__dirname, 'node_modules/fflate'),
    },
  },
  test: {
    environment: 'jsdom',
    silent: 'passed-only',
    setupFiles: ['./vitest.setup.ts'],
    // The default 5s is too tight for this suite: several tests re-import a
    // whole module graph per case (vi.resetModules() + a dynamic import of
    // nativeAppService), and the import phase alone runs into minutes. Under
    // CPU contention those tests legitimately need longer, and failing them on
    // time alone turns a green run red for no cause. `test:pr:web:unit` caps
    // workers for the same reason; a real hang still fails, just 20s later.
    testTimeout: 20_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      // Playwright web e2e specs — run via `pnpm test:e2e:web`, not vitest.
      '**/e2e/**',
      '**/*.browser.test.ts',
      '**/*.browser.test.tsx',
      '**/*.tauri.test.ts',
      // Android device e2e — run via `pnpm test:android`, not the unit lane.
      '**/*.android.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/**/test/**',
      ],
    },
  },
});
