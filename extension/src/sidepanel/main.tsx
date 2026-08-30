import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installOcrEngine } from '../perception/register-ocr';
import './styles.css';

// Install the real local OCR engine for this document. Lazy: nothing heavy loads
// until the visual pipeline first analyzes a captured region.
installOcrEngine();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
