import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installOcrEngine } from '../perception/register-ocr';
import { installVisionEngine } from '../perception/register-vision';
import './styles.css';
import './theme.css';

// Install the real local OCR engine for this document. Lazy: nothing heavy loads
// until the visual pipeline first analyzes a captured region.
installOcrEngine();

// M3 vision engine — loads icon-detect-640.onnx lazily; falls back to heuristics
// if model unavailable. Never blocks panel load: registration is free (dynamic
// import on first analyzing run) and load failures degrade to heuristic labels.
try {
  installVisionEngine();
} catch {
  console.warn('[PrivAgent] vision engine unavailable — continuing with heuristics');
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
