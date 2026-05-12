import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root in DOM');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
