import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const APP_URL = import.meta.env.VITE_APP_URL ?? 'https://api.lipdiffusion.uk/gradio-ui'
const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ??
  (typeof window !== 'undefined' ? window.location.origin : undefined)

const HERO_VIDEO = '/media/fusion-result.mp4'
const FACE_SOURCE = '/media/face-source.jpg'
const BASE_TRACK = '/media/base-track.mp4'
const CREATIVE_DEMO = '/media/creative-demo.mp4'

async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 5,
  baseDelay = 1000,
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)

      if ((response.status === 502 || response.status === 503) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500
        console.warn(
          `[fetchWithRetry] Attempt ${attempt + 1}/${maxRetries + 1} failed with ${response.status}. Retrying in ${Math.round(delay)}ms...`,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500
        console.warn(
          `[fetchWithRetry] Attempt ${attempt + 1}/${maxRetries + 1} failed with network error. Retrying in ${Math.round(delay)}ms...`,
          error,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
    }
  }

  throw lastError ?? new Error('Max retries exceeded')
}

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

const FEATURE_CARDS = [
  {
    titleEn: 'Clone your tone',
    titleJa: '声質コピー',
    bodyEn: 'Upload a short self-intro and the studio mirrors your tone and energy.',
    bodyJa: '数十秒の声だけであなたらしい声質を再現。余計な調整は不要です。',
    tag: 'Voice',
  },
  {
    titleEn: 'Lip-sync any script',
    titleJa: '好きなセリフで口パク',
    bodyEn: 'Drop in any line and see lips match perfectly without manual keyframes.',
    bodyJa: '台本を入れ替えても自動で口の動きが合うので、編集はすべてブラウザで完結。',
    tag: 'Script',
  },
  {
    titleEn: 'Swap faces cleanly',
    titleJa: '顔合成を一発で',
    bodyEn: 'Blend your face onto existing footage while keeping lighting and motion natural.',
    bodyJa: '顔だけをきれいに差し替え。光と動きが自然に馴染むので違和感が出ません。',
    tag: 'Face',
  },
  {
    titleEn: 'All-in-one render',
    titleJa: '声・口・セリフ・顔をまとめて',
    bodyEn: 'Voice copy, lip-sync, script change, and face merge finish in a single run.',
    bodyJa: '声質コピー・口パク・セリフ差し替え・顔合成をまとめて一括処理。',
    tag: 'One click',
  },
]

const SHOWREEL_CLIPS = [
  {
    src: '/media/voice-morph-2.mp4',
    titleEn: 'Voice clone with your tone',
    titleJa: '声質コピーで自然なトーン',
  },
  {
    src: CREATIVE_DEMO,
    titleEn: 'Script + lip-sync preview',
    titleJa: 'セリフ差し替えと口パク例',
  },
  {
    src: HERO_VIDEO,
    titleEn: 'Merged result sample',
    titleJa: '合成後の完成動画',
  },
]

const FLOW_POINTS = [
  {
    titleEn: 'Use your own assets',
    titleJa: '自分の素材をそのまま使える',
    bodyEn: 'Drop in your voice, base video, and face photo. No extra prep work.',
    bodyJa: '自分の声・ベース動画・顔写真をアップするだけ。事前の調整は不要です。',
  },
  {
    titleEn: 'One run to finish',
    titleJa: '1タップで同時処理',
    bodyEn: 'The studio handles voice copy, lip moves, script swap, and face merge together.',
    bodyJa: '声質コピー、口の動き、セリフ差し替え、顔合成を同時に処理します。',
  },
  {
    titleEn: 'Share instantly',
    titleJa: 'そのまま共有できる',
    bodyEn: 'Render, preview, and download right in the browser. No editing timeline needed.',
    bodyJa: 'ブラウザ上でそのままプレビューしてダウンロード。編集タイムラインは不要。',
  },
]

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

  useEffect(() => {
    async function exchangeOAuthCode() {
      if (!supabase) return
      const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
      const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
      if (!hasCode || !hasState) return
      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href)
      if (error) {
        console.error('[auth] OAuth exchange failed', error)
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    }
    void exchangeOAuthCode()
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
        const response = await fetchWithRetry(API_BASE + '/billing/status', {
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

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Supabase の環境変数が不足しています。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: OAUTH_REDIRECT_URL,
        },
      })
      if (error) throw error
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'Googleログインに失敗しました。')
    }
  }

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
        setAuthMessage('確認メールを送信しました。受信箱を確認してください。')
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

    const cookieOptions = `domain=.lipdiffusion.uk; path=/; max-age=0; SameSite=None; Secure`
    document.cookie = `user_email=; ${cookieOptions}`
    document.cookie = `sb_access_token=; ${cookieOptions}`
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
      const response = await fetchWithRetry(API_BASE + '/billing/checkout', {
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
      const response = await fetchWithRetry(API_BASE + '/billing/portal', {
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

  const handleStudioClick = () => {
    if (!isAuthenticated || !userEmail || !session?.access_token) return
    const maxAge = 3600
    const cookieOptions = `domain=.lipdiffusion.uk; path=/; max-age=${maxAge}; SameSite=None; Secure`
    document.cookie = `user_email=${encodeURIComponent(userEmail)}; ${cookieOptions}`
    document.cookie = `sb_access_token=${session.access_token}; ${cookieOptions}`
  }

  const isAuthenticated = Boolean(session?.access_token)
  const userEmail = session?.user?.email ?? ''

  return (
    <div className="App">
      <div className="background-glow" aria-hidden />

      <header className="hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">LipDiffusion Studio ・ 日本語 / English</p>
            <h1>Make yourself speak anywhere</h1>
            <p className="lede">
              Clone your voice, sync lips, rewrite the script, and swap faces in one go. Your own
              voice and visuals become a new video in minutes.
            </p>
            <p className="lede lede-ja">
              声質コピー・口パク・セリフ差し替え・顔合成をまとめて処理。自分の声と顔で、数分で新しい映像を作れます。
            </p>
            <div className="hero-actions">
              <a
                className="primary-link"
                href={
                  isAuthenticated
                    ? `${APP_URL}?email=${encodeURIComponent(userEmail)}`
                    : '#auth'
                }
                target={isAuthenticated ? '_blank' : undefined}
                rel={isAuthenticated ? 'noopener' : undefined}
                onClick={handleStudioClick}
              >
                {isAuthenticated ? 'Open studio / スタジオを開く' : 'Start free / 無料で始める'}
              </a>
              <div className="cta-note">
                <span className="chip">3 tickets on free sign-up</span>
                <span className="chip">Browser only ・ No editor needed</span>
                <span className="chip">For creators & teams</span>
              </div>
            </div>
            {isAuthenticated && (
              <p className="signed-in-banner">
                Signed in as {userEmail || session?.user?.id}
              </p>
            )}
          </div>

          <div className="hero-visual">
            <div className="video-shell">
              <video
                src={HERO_VIDEO}
                autoPlay
                muted
                loop
                playsInline
                poster="/media/face-source.jpg"
              />
              <div className="video-label">
                <div>Face blend demo</div>
                <small>声・口パク・顔合成の仕上がりサンプル</small>
              </div>
            </div>
            <div className="source-strip">
              <div className="mini-card">
                <img src={FACE_SOURCE} alt="Face source" />
                <p>Face source / 元の顔</p>
              </div>
              <div className="mini-card">
                <video src={BASE_TRACK} autoPlay muted loop playsInline />
                <p>Base video / ベース映像</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="panel-grid panel-grid-prime">
        <section id="auth" className="panel auth-panel">
          <div className="panel-header">
            <h2>Account / アカウント</h2>
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
              <code>VITE_SUPABASE_URL</code> と <code>VITE_SUPABASE_ANON_KEY</code>
              を入力してください。
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
                <select
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as 'signin' | 'signup')}
                >
                  <option value="signup">Create account</option>
                  <option value="signin">Sign in</option>
                </select>
              </label>

              <button type="submit" disabled={authStatus === 'loading'}>
                {authMode === 'signup' ? 'Send confirmation email' : 'Sign in'}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={handleGoogleSignIn}
                disabled={authStatus === 'loading'}
              >
                Sign in with Google
              </button>
              {authMessage && (
                <p className={authStatus === 'error' ? 'error' : 'muted'}>{authMessage}</p>
              )}
            </form>
          )}
        </section>

        <section className="panel billing-panel">
          <div className="panel-header">
            <h2>Billing & Tickets / 課金とチケット</h2>
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
                    <span className="label">更新予定日</span>
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
            <h2>Latest renders / 過去24時間</h2>
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
      </div>

      <section className="panel feature-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">All-in-one pipeline</p>
            <h2>Voice, lips, script, and face in one pass</h2>
            <p className="lede">
              English & Japanese creators can finish a believable clone video without touching a
              timeline.
            </p>
            <p className="lede lede-ja">
              誰でもブラウザだけで自然なクローン動画を完成。編集ソフトは不要です。
            </p>
          </div>
          <div className="chip chip-strong">無料登録でチケット3枚プレゼント</div>
        </div>
        <div className="feature-grid">
          {FEATURE_CARDS.map((card) => (
            <article className="feature-card" key={card.titleEn}>
              <span className="tag">{card.tag}</span>
              <h3>
                {card.titleEn} <span className="muted-text">/ {card.titleJa}</span>
              </h3>
              <p>{card.bodyEn}</p>
              <p className="muted-text">{card.bodyJa}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel showreel-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Showreel</p>
            <h2>See it in motion / 動きで見る</h2>
            <p className="lede">
              Provided clips show how voice, lip-sync, and face merge land after one run.
            </p>
            <p className="lede lede-ja">声・口パク・顔が一括で仕上がるサンプルを再生して確認。</p>
          </div>
          <div className="chip">Your assets stay yours</div>
        </div>
        <div className="showreel-grid">
          {SHOWREEL_CLIPS.map((clip) => (
            <div className="showreel-card" key={clip.src}>
              <video
                src={clip.src}
                loop
                playsInline
                controls
                preload="auto"
                muted={false}
              />
              <div className="showreel-meta">
                <strong>{clip.titleEn}</strong>
                <span>{clip.titleJa}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel flow-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Creation flow</p>
            <h2>From upload to share in three beats / 3ステップで完成</h2>
          </div>
        </div>
        <div className="flow-grid">
          {FLOW_POINTS.map((item) => (
            <div className="flow-card" key={item.titleEn}>
              <h3>
                {item.titleEn} <span className="muted-text">/ {item.titleJa}</span>
              </h3>
              <p>{item.bodyEn}</p>
              <p className="muted-text">{item.bodyJa}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export default App
