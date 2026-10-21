import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/session.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionGate } from './session/SessionGate.js';
import { applyPalette, loadPalette } from './settings/palette.js';

// Before the first render, so the saved palette never flashes the default.
applyPalette(loadPalette());

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root element');
}
createRoot(container).render(
  <StrictMode>
    <SessionGate />
  </StrictMode>,
);
