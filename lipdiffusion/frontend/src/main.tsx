import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import App from './App'
import { Generate } from './pages/Generate'
import { LlasaTest } from './pages/LlasaTest'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* トップページ: 認証・サブスクUIを含む App */}
        <Route path="/" element={<App />} />
        {/* ASMR音声生成スタジオ */}
        <Route path="/generate" element={<Generate />} />
        {/* LLaSA 3B テスト */}
        <Route path="/llasa" element={<LlasaTest />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
