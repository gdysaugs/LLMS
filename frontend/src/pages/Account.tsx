import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import './account.css'
import { supabase } from '../lib/supabaseClient'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const API_GATEWAY = (import.meta.env.VITE_API_GATEWAY_BASE_URL || '').replace(/\/$/, '')
const BASE_URL = API_GATEWAY || API_BASE || ''

type FileMeta = {
  id: string
  title: string
  tags?: string[]
  size_bytes?: number
  created_at?: string
  expires_at?: string
  access_tier?: 'free' | 'premium'
  price_units?: number
  price_tokens?: number
  open_count?: number
}

const formatUnits = (units?: number) => {
  if (!Number.isFinite(units)) return '0'
  const value = (units || 0) / 2
  return value % 1 === 0 ? String(value) : value.toFixed(1)
}

const formatDate = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString()
}

const formatFileSize = (bytes?: number) => {
  if (!bytes || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function Account() {
  const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(null)
  const [balances, setBalances] = useState<{ tokenUnits: number; pointUnits: number } | null>(null)
  const [files, setFiles] = useState<FileMeta[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading')
  const [message, setMessage] = useState('')

  const authToken = session?.access_token || ''

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setStatus('idle')
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const fetchAccount = async () => {
      if (!authToken || !BASE_URL) return
      setStatus('loading')
      setMessage('')
      try {
        const balanceRes = await fetch(`${BASE_URL}/balances`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        const balanceData = await balanceRes.json().catch(() => ({}))
        if (!balanceRes.ok) {
          throw new Error(balanceData?.error || '残高の取得に失敗しました')
        }
        setBalances({
          tokenUnits: Number(balanceData?.token_units ?? 0),
          pointUnits: Number(balanceData?.point_units ?? 0),
        })
        const filesRes = await fetch(`${BASE_URL}/files/mine?limit=100`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        const filesData = await filesRes.json().catch(() => ({}))
        if (!filesRes.ok) {
          throw new Error(filesData?.error || '投稿履歴の取得に失敗しました')
        }
        setFiles((filesData?.items || []) as FileMeta[])
        setStatus('idle')
      } catch (error) {
        setStatus('error')
        setMessage(error instanceof Error ? error.message : '読み込みに失敗しました')
      }
    }
    void fetchAccount()
  }, [authToken])

  if (!session) {
    return (
      <div className="account-page">
        <div className="account-card">
          <p>ログインが必要です。</p>
          <button className="primary" onClick={() => navigate('/')}>
            ログインへ
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="account-page">
      <header className="account-header">
        <div>
          <p className="eyebrow">Account</p>
          <h1>アカウント</h1>
          <p className="muted">投稿履歴と残高を確認できます。</p>
        </div>
        <div className="account-actions">
          <Link className="ghost" to="/">
            チャットへ
          </Link>
        </div>
      </header>

      <section className="account-grid">
        <div className="account-card">
          <h2>保有残高</h2>
          <div className="balance-list">
            <div>
              <span>トークン</span>
              <strong>{formatUnits(balances?.tokenUnits)}</strong>
            </div>
            <div>
              <span>ポイント</span>
              <strong>{formatUnits(balances?.pointUnits)}</strong>
            </div>
          </div>
        </div>

        <div className="account-card account-card--wide">
          <div className="card-head">
            <h2>投稿履歴</h2>
            <span className="muted">{files.length} 件</span>
          </div>
          {status === 'loading' && <p className="muted">読み込み中...</p>}
          {status === 'error' && <p className="error">{message}</p>}
          {status === 'idle' && files.length === 0 && (
            <p className="muted">まだ投稿がありません。</p>
          )}
          <div className="file-grid">
            {files.map((file) => (
              <div key={file.id} className="file-item">
                <div className="file-item__title">{file.title}</div>
                <div className="file-item__meta">
                  {formatFileSize(file.size_bytes)}
                  {typeof file.open_count === 'number' && <span>開封: {file.open_count}</span>}
                  {file.access_tier === 'premium' ? (
                    <span>
                      プレミアム: {file.price_tokens ?? (file.price_units || 0) / 2} トークン
                    </span>
                  ) : (
                    <span>フリー</span>
                  )}
                </div>
                <div className="file-item__meta">
                  {file.created_at && <span>投稿: {formatDate(file.created_at)}</span>}
                  {file.expires_at && <span>期限: {formatDate(file.expires_at)}</span>}
                </div>
                <div className="file-item__tags">
                  {(file.tags || []).map((tag) => (
                    <span key={tag} className="tag">
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
