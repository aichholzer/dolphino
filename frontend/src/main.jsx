import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/faustina';
import '@fontsource-variable/hanken-grotesk';
import { App } from './app';
import './style.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
