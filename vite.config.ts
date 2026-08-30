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
  // Bundled OCR runtime assets (Tesseract worker, wasm core, eng language data) live
  // under extension/public and are copied verbatim into dist/ so they load offline
  // from the extension origin via chrome.runtime.getURL('ocr/...').
  publicDir: 'extension/public',
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
