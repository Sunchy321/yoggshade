import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './editor.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <Editor />
  </StrictMode>,
);
