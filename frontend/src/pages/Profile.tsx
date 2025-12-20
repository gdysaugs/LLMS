import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import './profile.css'
import { supabase } from '../lib/supabaseClient'

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
const defaultAvatar = '/media/default-avatar.png'

type BillingStatus = {
  tickets: number | null
  subscription_status: string | null
}

async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
  baseDelay = 800,
): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      if ((res.status === 502 || res.status === 503) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      return res
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
    }
  }
  throw lastError ?? new Error('Max retries exceeded')
}

export function Profile() {
  const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string>(defaultAvatar)
  const [displayName, setDisplayName] = useState('')
  const [plan, setPlan] = useState<BillingStatus>({ tickets: null, subscription_status: null })
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading')
  const [message, setMessage] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setStatus('idle')
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setStatus('idle')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const fetchBilling = async () => {
      if (!session?.access_token) return
      try {
        const res = await fetchWithRetry(API_BASE + '/billing/status', {
          headers: { Authorization: 'Bearer ' + session.access_token },
        })
        const data = (await res.json()) as BillingStatus
        if (!res.ok) throw new Error((data as any)?.detail || 'ステータス取得に失敗しました')
        setPlan({
          tickets: typeof data.tickets === 'number' ? data.tickets : null,
          subscription_status: data.subscription_status || null,
        })
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'ステータス取得に失敗しました')
      }
    }
    void fetchBilling()
  }, [session])

  useEffect(() => {
    const metaUrl = (session?.user?.user_metadata as any)?.avatar_url as string | undefined
    const name =
      ((session?.user?.user_metadata as any)?.name as string | undefined) ||
      session?.user?.email?.split('@')[0] ||
      ''
    if (metaUrl && !metaUrl.includes('googleusercontent.com')) setAvatarUrl(metaUrl)
    if (name) setDisplayName(name)
  }, [session])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const localAvatar = localStorage.getItem('customAvatar')
    const localName = localStorage.getItem('customDisplayName')
    if (localAvatar) setAvatarUrl(localAvatar)
    if (localName) setDisplayName(localName)
  }, [])

  const handleAvatarChange = (file: File | null) => {
    if (!file) {
      setAvatarUrl(defaultAvatar)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      setAvatarUrl(result || defaultAvatar)
    }
    reader.readAsDataURL(file)
  }

  const handleSave = async () => {
    try {
      setIsSaving(true)
      setMessage('')
      if (typeof window !== 'undefined') {
        if (avatarUrl && avatarUrl !== defaultAvatar) {
          localStorage.setItem('customAvatar', avatarUrl)
        } else {
          localStorage.removeItem('customAvatar')
        }
        if (displayName) {
          localStorage.setItem('customDisplayName', displayName)
        } else {
          localStorage.removeItem('customDisplayName')
        }
      }
      if (session) {
        await supabase?.auth.updateUser({
          data: {
            avatar_url: avatarUrl !== defaultAvatar ? avatarUrl : null,
            name: displayName || null,
          },
        })
      }
      setMessage('保存しました')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    navigate('/')
  }

  const avatarSrc = useMemo(() => {
    if (!avatarUrl || avatarUrl.includes('googleusercontent.com')) return defaultAvatar
    return avatarUrl
  }, [avatarUrl])

  if (!session) {
    return (
      <div className="profile-page">
        <div className="profile-card">
          <p className="muted">ログインが必要です</p>
          <button className="primary" onClick={() => navigate('/')}>
            トップへ戻る
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="profile-page">
      <header className="profile-hero">
        <div>
          <p className="eyebrow">My Account</p>
          <h1>プロフィールとサブスク設定</h1>
          <p className="muted">アバター、表示名を変更して、スタジオに反映できます（現状フロントUIのみ）。</p>
        </div>
        <div className="hero-actions">
          <button className="ghost" onClick={() => navigate('/generate')}>
            スタジオへ戻る
          </button>
          <button className="primary" onClick={handleSignOut}>
            サインアウト
          </button>
        </div>
      </header>

      <div className="profile-grid">
        <section className="profile-card">
          <div className="card-head">
            <h3>アバター</h3>
            <span className="muted">未設定時はデフォルトを表示</span>
          </div>
          <div className="avatar-row">
            <div className="avatar-preview">
              <img
                src={avatarSrc}
                alt="avatar"
                onError={(e) => {
                  if (e.currentTarget.src !== defaultAvatar) e.currentTarget.src = defaultAvatar
                }}
              />
            </div>
            <div className="avatar-actions">
              <input type="file" accept="image/*" onChange={(e) => handleAvatarChange(e.target.files?.[0] ?? null)} />
              <button className="ghost" onClick={() => handleAvatarChange(null)}>
                デフォルトに戻す
              </button>
            </div>
          </div>
          <div className="field">
            <label>
              表示名
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="表示名を入力" />
            </label>
          </div>
          <button className="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? '保存中...' : '保存する'}
          </button>
          {message && <div className="muted">{message}</div>}
        </section>

        <section className="profile-card">
          <div className="card-head">
            <h3>プラン / チケット</h3>
            <span className="muted">サブスク状態を確認</span>
          </div>
          <div className="plan-row">
            <div>
              <p className="label">メール</p>
              <p className="value">{session.user?.email}</p>
            </div>
            <div>
              <p className="label">サブスク</p>
              <p className="value">{plan.subscription_status || '未契約'}</p>
            </div>
            <div>
              <p className="label">チケット</p>
              <p className="value">
                {status === 'loading' ? '読み込み中...' : plan.tickets !== null ? `${plan.tickets} 枚` : '未取得'}
              </p>
            </div>
          </div>
          <div className="muted">購入や更新はトップ/スタジオのサブスクボタンから行ってください。</div>
        </section>
      </div>
    </div>
  )
}
