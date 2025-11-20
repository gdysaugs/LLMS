import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const APP_URL =
  import.meta.env.VITE_APP_URL ?? 'https://api.lipdiffusion.uk/gradio-ui'

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi')



type HistoryItem = {
  output_url: string
  created_at: string
}

type BillingResponse = {
  email: string
  tickets: number
  subscription_status?: string | null
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  current_period_end?: string | null
  has_active_subscription: boolean
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  )
  const [historyMessage, setHistoryMessage] = useState('')
  const [billing, setBilling] = useState<BillingResponse | null>(null)
  const [billingStatus, setBillingStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  )
  const [billingMessage, setBillingMessage] = useState('')
  const [billingAction, setBillingAction] = useState<'idle' | 'loading'>('idle')

  useEffect(() => {
    if (!supabase) return

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  const fetchHistory = useCallback(
    async (activeSession: Session | null) => {
      if (!supabase || !activeSession?.user?.email) {
        setHistory([])
        setHistoryStatus('idle')
        setHistoryMessage('')
        return
      }

      setHistoryStatus('loading')
      setHistoryMessage('')

      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { data, error } = await supabase
          .from('generation_history')
          .select('output_url, created_at')
          .eq('email', activeSession.user.email)
          .gte('created_at', since)
          .order('created_at', { ascending: false })

        if (error) throw error
        setHistory(data ?? [])
        setHistoryStatus('success')
      } catch (error) {
        setHistory([])
        setHistoryStatus('error')
        setHistoryMessage(
          error instanceof Error ? error.message : '履歴を取得できませんでした。',
        )
      }
    },
    [],
  )

  const fetchBillingStatus = useCallback(
    async (activeSession: Session | null) => {
      if (!activeSession?.access_token) {
        setBilling(null)
        setBillingStatus('idle')
        setBillingMessage('')
        return
      }

      setBillingStatus('loading')
      setBillingMessage('')

      try {
        const response = await fetch(API_BASE + '/billing/status', {
          headers: {
            Authorization: 'Bearer ' + activeSession.access_token,
          },
        })
        const data = await response.json()
        if (!response.ok) {
          throw new Error((data && data.detail) || '課金ステータスを取得できませんでした。')
        }
        setBilling(data as BillingResponse)
        setBillingStatus('success')
      } catch (error) {
        setBilling(null)
        setBillingStatus('error')
        setBillingMessage(
          error instanceof Error ? error.message : '課金ステータスを取得できませんでした。',
        )
      }
    },
    [],
  )

  useEffect(() => {
    fetchBillingStatus(session)
    if (session?.user?.email) {
      fetchHistory(session)
    } else {
      setHistory([])
      setHistoryStatus('idle')
      setHistoryMessage('')
    }
  }, [session, fetchHistory, fetchBillingStatus])

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Supabase の環境変数が未設定です。')
      return
    }

    setAuthStatus('loading')
    setAuthMessage('')

    try {
      if (authMode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
        })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('確認メールを送信しました。受信箱をチェックしてください。')
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('サインインしました。')
      }
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(
        error instanceof Error ? error.message : '認証中に不明なエラーが発生しました。',
      )
    }
  }

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  const handleHistoryDownload = (url: string) => {
    if (!url) return
    const confirmed = window.confirm('この動画をダウンロードしますか？')
    if (confirmed) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const handleStartSubscription = async () => {
    if (!session?.access_token) {
      setBillingMessage('サインインしてからサブスクを開始してください。')
      return
    }
    setBillingAction('loading')
    setBillingMessage('')
    try {
      const response = await fetch(API_BASE + '/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({
          success_url: window.location.origin + '?checkout=success',
          cancel_url: window.location.href,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data?.url) {
        throw new Error((data && data.detail) || 'Stripe Checkout を開始できませんでした。')
      }
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(
        error instanceof Error ? error.message : 'Stripe Checkout を開始できませんでした。',
      )
    } finally {
      setBillingAction('idle')
    }
  }

  const handleOpenPortal = async () => {
    if (!session?.access_token) {
      setBillingMessage('サインインしてから請求情報を管理してください。')
      return
    }
    setBillingAction('loading')
    setBillingMessage('')
    try {
      const response = await fetch(API_BASE + '/billing/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({
          return_url: window.location.origin + '?portal=return',
        }),
      })
      const data = await response.json()
      if (!response.ok || !data?.url) {
        throw new Error((data && data.detail) || 'Stripe ポータルを開けませんでした。')
      }
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(
        error instanceof Error ? error.message : 'Stripe ポータルを開けませんでした。',
      )
    } finally {
      setBillingAction('idle')
    }
  }

  const isAuthenticated = Boolean(session?.access_token)
  const userEmail = session?.user?.email ?? ''

  return (
    <div className="App">
      <header className="hero">
        <p className="eyebrow">lipdiffusion</p>
        <h1>Voice cloning & lip-sync studio</h1>
        <p className="lede">
          GPU ワーカーで SoVITS / Wav2Lip / FaceFusion をまとめて実行。音声クローンから動画生成
          までブラウザだけで完結します。
        </p>
        <div className="hero-actions">
          <a
            className="primary-link"
            href={isAuthenticated ? APP_URL : '#auth'}
            target={isAuthenticated ? '_blank' : undefined}
            rel={isAuthenticated ? 'noreferrer' : undefined}
          >
            {isAuthenticated ? 'スタジオを開く' : '無料アカウント作成'}
          </a>
          <a className="secondary-link" href="mailto:hello@lipdiffusion.uk">
            デモを依頼
          </a>
        </div>
        {isAuthenticated && (
          <p className="signed-in-banner">Signed in as {userEmail || session?.user?.id}</p>
        )}
      </header>

      <section id="auth" className="panel auth-panel">
        <div className="panel-header">
          <h2>アカウント</h2>
          <span
            className={
              'status ' +
              (isAuthenticated
                ? 'status-success'
                : isAuthConfigured
                  ? 'status-warning'
                  : 'status-error')
            }
          >
            {isAuthenticated ? 'signed in' : isAuthConfigured ? 'guest' : 'auth disabled'}
          </span>
        </div>

        {!isAuthConfigured ? (
          <p className="error">
            Supabase の URL / anon key が未設定です。Cloudflare Pages の環境変数に
            <code>VITE_SUPABASE_URL</code> と <code>VITE_SUPABASE_ANON_KEY</code> を入力してください。
          </p>
        ) : isAuthenticated ? (
          <div className="auth-signed-in">
            <p>
              Logged in as <strong>{userEmail || session?.user?.id}</strong>
            </p>
            <div className="auth-actions">
              <button type="button" className="button-secondary" onClick={handleSignOut}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                minLength={6}
                required
              />
            </label>

            <label className="field">
              <span>Action</span>
              <select value={authMode} onChange={(e) => setAuthMode(e.target.value as 'signin' | 'signup')}>
                <option value="signup">Create account</option>
                <option value="signin">Sign in</option>
              </select>
            </label>

            <button type="submit" disabled={authStatus === 'loading'}>
              {authMode === 'signup' ? 'Send confirmation email' : 'Sign in'}
            </button>
            {authMessage && (
              <p className={authStatus === 'error' ? 'error' : 'muted'}>{authMessage}</p>
            )}
          </form>
        )}
      </section>

      <section className="panel billing-panel">
        <div className="panel-header">
          <h2>サブスク / チケット</h2>
          <span
            className={
              'status ' +
              (billingStatus === 'error'
                ? 'status-error'
                : billing?.has_active_subscription
                  ? 'status-success'
                  : 'status-warning')
            }
          >
            {billingStatus === 'loading'
              ? 'loading'
              : billing?.has_active_subscription
                ? 'active'
                : 'inactive'}
          </span>
        </div>
        {!isAuthenticated ? (
          <p className="muted">サインインするとチケット残高とサブスク状態を確認できます。</p>
        ) : billingStatus === 'loading' ? (
          <p className="muted">読み込み中...</p>
        ) : billingStatus === 'error' ? (
          <p className="error">{billingMessage}</p>
        ) : (
          <>
            <ul className="billing-stats">
              <li>
                <span className="label">Tickets</span>
                <strong>{billing?.tickets ?? 0}</strong>
              </li>
              <li>
                <span className="label">Status</span>
                <strong>{billing?.subscription_status ?? 'inactive'}</strong>
              </li>
              {billing?.current_period_end && (
                <li>
                  <span className="label">更新予定</span>
                  <span>{new Date(billing.current_period_end).toLocaleDateString()}</span>
                </li>
              )}
            </ul>
            <div className="billing-actions">
              <button
                type="button"
                onClick={handleStartSubscription}
                disabled={!isAuthenticated || billingAction === 'loading'}
              >
                Stripe で購読
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={handleOpenPortal}
                disabled={!isAuthenticated || billingAction === 'loading'}
              >
                請求情報を管理
              </button>
            </div>
            {billingMessage && <p className="muted">{billingMessage}</p>}
          </>
        )}
      </section>

      <section className="panel history-panel">
        <div className="panel-header">
          <h2>最新生成履歴（24時間）</h2>
          <button
            type="button"
            className="button-secondary"
            disabled={!isAuthenticated || historyStatus === 'loading'}
            onClick={() => fetchHistory(session)}
          >
            更新
          </button>
        </div>

        {!isAuthenticated ? (
          <p className="muted">ログインすると直近24時間の生成URLが表示されます。</p>
        ) : historyStatus === 'loading' ? (
          <p className="muted">読み込み中...</p>
        ) : historyStatus === 'error' ? (
          <p className="error">{historyMessage}</p>
        ) : history.length === 0 ? (
          <p className="muted">過去24時間の生成履歴はありません。</p>
        ) : (
          <ul className="history-list">
            {history.map((item) => (
              <li key={`${item.created_at}-${item.output_url}`}>
                <button
                  type="button"
                  className="history-link"
                  onClick={() => handleHistoryDownload(item.output_url)}
                >
                  {item.output_url}
                </button>
                <span className="history-time">
                  {new Date(item.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel highlights">
        <h2>Why teams use lipdiffusion</h2>
        <ul>
          <li>🎙️ SoVITS + wav2lip + FaceFusion を 1 タップで実行</li>
          <li>🧠 RTX 3090 / L40S など RunPod GPU を常時確保</li>
          <li>🔐 Supabase Auth でユーザーを一元管理</li>
          <li>⚙️ API Gateway からバッチ実行や自動化も可能</li>
        </ul>
      </section>

      <section className="panel highlights">
        <h2>ロードマップ</h2>
        <ul>
          <li>📦 プロジェクト別の生成ログ & 課金レポート</li>
          <li>🗣️ 多言語 SoVITS プロンプトプリセット</li>
          <li>🎬 クリエイター向けテンプレと自動公開ワークフロー</li>
        </ul>
      </section>
    </div>
  )
}

export default App
