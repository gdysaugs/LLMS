import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { Generate } from './pages/Generate.tsx'
import { Trim } from './pages/Trim.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/generate" element={<Generate />} />
        <Route path="/trim" element={<Trim />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
