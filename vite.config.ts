import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import manifest from './extension/manifest.ts';

// PrivAgent build (M0 scaffold).
// Vite 8 transforms with Rolldown/oxc (not esbuild), so JSX is configured via `oxc.jsx`
// (automatic runtime, default `react` import source). @vitejs/plugin-react is intentionally
// omitted for the scaffold to avoid the Vite 8 rolldown/oxc-babel/react-compiler peer chain.
export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
});
