import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/variables.css';
import './styles/reset.css';
import './styles/global.css';
import './styles/responsive.css';
import App from './App.jsx';
import reportWebVitals from './reportWebVitals.js';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();
