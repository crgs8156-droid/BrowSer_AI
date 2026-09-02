import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import manifest from './extension/manifest.ts';

// PrivAgent build (M0 scaffold).
// Vite 8 transforms with Rolldown/oxc (not esbuild), so JSX is configured via `oxc.jsx`
// (automatic runtime, default `react` import source). @vitejs/plugin-react is intentionally
// omitted for the scaffold to avoid the Vite 8 rolldown/oxc-babel/react-compiler peer chain.

/**
 * M7.5 — copies the ONNX Runtime WASM files (WASM-only backend, no WebGPU) and the
 * BlazeFace model (when present — `scripts/fetch-blazeface.sh` fetches it; absence
 * degrades gracefully to zero faces) into dist/ as static assets.
 */
function copyOnnxAssets() {
  return {
    name: "copy-onnx-assets",
    closeBundle() {
      const ortSource = "node_modules/onnxruntime-web/dist";
      const ortOut = "dist/ort";
      mkdirSync(ortOut, { recursive: true });
      for (const file of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
        copyFileSync(`${ortSource}/${file}`, `${ortOut}/${file}`);
      }
      const model = "extension/src/perception/visual/models/blazeface.onnx";
      if (existsSync(model)) {
        const modelOut = "dist/models";
        mkdirSync(modelOut, { recursive: true });
        copyFileSync(model, `${modelOut}/blazeface.onnx`);
      } else {
        console.warn("[privagent] blazeface.onnx not found — face detection disabled (pipeline continues)");
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest }), copyOnnxAssets()],
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
