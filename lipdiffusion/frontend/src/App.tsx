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

type FeatureCard = {
  titleEn: string
  titleJa: string
  bodyEn: string
  bodyJa: string
  tag: string
}

type ShowreelClip = {
  src: string
  titleEn: string
  titleJa: string
  desc?: string
}

const FEATURE_CARDS: FeatureCard[] = [
  {
    titleEn: 'Copy your voice in 1 second',
    titleJa: '1秒の音声で声質をコピー',
    bodyEn: 'Drop a 1-second clip; we mirror tone and texture instantly.',
    bodyJa: '1秒の音声だけで声質と特徴をそのまま再現。',
    tag: 'Voice',
  },
  {
    titleEn: 'Sync lips to the new script',
    titleJa: '新しいセリフに口パクを同期',
    bodyEn: 'Type any line; lips match the cloned audio with no editing.',
    bodyJa: '好きなセリフを入れるだけで、クローン音声に合わせて自動で口パク。',
    tag: 'Script',
  },
  {
    titleEn: 'Optional face merge',
    titleJa: '顔合成はオプションで高精度',
    bodyEn: 'Add a face photo to blend cleanly on existing footage.',
    bodyJa: '顔写真を追加すれば映像に高精度で合成。入れなくても動画は完成。',
    tag: 'Face',
  },
  {
    titleEn: 'World-first all-in-one engine',
    titleJa: '世界初の一括合成エンジン',
    bodyEn: 'Voice, lips, script, and face finish in one pass—no timeline work.',
    bodyJa: '声・口パク・セリフ・顔を一度で処理。編集タイムライン作業は不要。',
    tag: 'One pass',
  },
]

const SHOWREEL_CLIPS: ShowreelClip[] = [
  {
    src: '/media/showreel-left.mp4',
    titleEn: '1s voice clone + script change',
    titleJa: '1秒音声で声質コピー＆セリフ変更',
    desc: 'Existing video, new cloned voice and script applied.',
  },
  {
    src: '/media/showreel-mid.mp4',
    titleEn: 'Emotional Japanese read',
    titleJa: '日本語特化の感情的読み上げでセリフ改変',
    desc: 'Emotion-focused JP delivery with modified lines.',
  },
  {
    src: '/media/showreel-right.mp4',
    titleEn: 'Face merge + script change',
    titleJa: '顔合成＋セリフ変更の例',
    desc: 'Face swapped from a photo and script replaced.',
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
      setAuthMessage('Supabase settings are missing / Supabase の設定が不足しています。')
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
      setAuthMessage(
        error instanceof Error
          ? error.message
          : 'Google sign-in failed / Googleログインに失敗しました。',
      )
    }
  }

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Supabase variables are not set / Supabase の環境変数が未設定です。')
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
        setAuthMessage('Confirmation email sent / 確認メールを送信しました。')
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('Signed in / サインインしました。')
      }
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(
        error instanceof Error
          ? error.message
          : 'Auth error occurred / 認証中にエラーが発生しました。',
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
    const confirmed = window.confirm('Download this video? / この動画をダウンロードしますか？')
    if (confirmed) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const handleStartSubscription = async () => {
    if (!session?.access_token) {
      setBillingMessage('Sign in first / 先にサインインしてください。')
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
        throw new Error((data && data.detail) || 'Stripe Checkout failed / 開始できませんでした。')
      }
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(
        error instanceof Error ? error.message : 'Stripe Checkout failed / 開始できませんでした。',
      )
    } finally {
      setBillingAction('idle')
    }
  }

  const handleOpenPortal = async () => {
    if (!session?.access_token) {
      setBillingMessage('Sign in first / 先にサインインしてください。')
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
        throw new Error((data && data.detail) || 'Stripe portal failed / ポータルを開けません。')
      }
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(
        error instanceof Error ? error.message : 'Stripe portal failed / ポータルを開けません。',
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
              世界初の合成エンジンで、声質コピー・口パク・セリフ差し替え・顔合成をまとめて処理。自分の声と顔で、数分で新しい映像を作れます。
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
                Create video / 動画を作成する
              </a>
              <div className="cta-note">
                <span className="chip">3 tickets on free sign-up</span>
                <span className="chip">Browser only ・ No editor needed</span>
                <span className="chip">For creators & teams</span>
                <span className="chip">Videos + audio only OK / 顔写真はオプション合成</span>
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
              <div className="mini-card tall-card">
                <img src={FACE_SOURCE} alt="Face source" />
                <p>Face source / 元の顔</p>
              </div>
              <div className="mini-card tall-card">
                <video src={BASE_TRACK} autoPlay loop muted playsInline />
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
              Supabase URL / anon key not set. Set <code>VITE_SUPABASE_URL</code> and{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> in Cloudflare Pages. / Supabase の URL / anon key
              が未設定です。Cloudflare Pages の環境変数に設定してください。
            </p>
          ) : isAuthenticated ? (
            <div className="auth-signed-in">
              <p>
                Logged in as <strong>{userEmail || session?.user?.id}</strong>
              </p>
              <div className="auth-actions">
                <button type="button" className="button-secondary" onClick={handleSignOut}>
                  Sign out / サインアウト
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
                <span>Password / パスワード</span>
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
                <span>Action / 操作</span>
                <select
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as 'signin' | 'signup')}
                >
                  <option value="signup">Create account / 新規登録</option>
                  <option value="signin">Sign in / サインイン</option>
                </select>
              </label>

              <button type="submit" disabled={authStatus === 'loading'}>
                {authMode === 'signup' ? 'Send confirmation email / 確認メール送信' : 'Sign in / サインイン'}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={handleGoogleSignIn}
                disabled={authStatus === 'loading'}
              >
                Sign in with Google / Googleでサインイン
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
            <p className="muted">
              Sign in to see tickets and subscription. / サインインするとチケット残高とサブスク状態を確認できます。
            </p>
          ) : billingStatus === 'loading' ? (
            <p className="muted">Loading... / 読み込み中...</p>
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
                    <span className="label">Renewal / 更新予定日</span>
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
                  Subscribe with Stripe / Stripe で購読
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={handleOpenPortal}
                  disabled={!isAuthenticated || billingAction === 'loading'}
                >
                  Manage billing / 請求情報を管理
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
              Refresh / 更新
            </button>
          </div>

          {!isAuthenticated ? (
            <p className="muted">Sign in to view recent outputs. / サインインすると直近の生成URLが表示されます。</p>
          ) : historyStatus === 'loading' ? (
            <p className="muted">Loading... / 読み込み中...</p>
          ) : historyStatus === 'error' ? (
            <p className="error">{historyMessage}</p>
          ) : history.length === 0 ? (
            <p className="muted">No renders in the last 24h. / 過去24時間の生成履歴はありません。</p>
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
            <p className="eyebrow">How to use</p>
            <h2>Voice, lips, script, and face in one pass / 世界初の一括合成エンジン</h2>
            <p className="lede">
              Copy a 1-second voice, sync to any script, optionally merge a face—then render in one
              run.
            </p>
            <p className="lede lede-ja">
              1秒の声で特徴をコピーし、好きなセリフに口パクを合わせ、顔合成もオプションで一括処理。
            </p>
          </div>
          <div className="chip chip-strong">3 tickets on sign-up / 無料登録でチケット3枚</div>
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
          <div className="chip">Your assets stay yours / 素材はあなたのまま</div>
        </div>
        <div className="showreel-grid">
          {SHOWREEL_CLIPS.map((clip) => (
            <div className="showreel-card" key={clip.src}>
              <video src={clip.src} playsInline controls preload="auto" muted={false} />
              <div className="showreel-meta">
                <strong>{clip.titleEn}</strong>
                <span>{clip.titleJa}</span>
                {clip.desc && <small className="muted-text">{clip.desc}</small>}
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

      <section className="panel terms-panel">
        <h2>Terms / 利用規約</h2>
        <ul className="terms-list">
          <li>
            Allowed assets only / 適法な素材のみアップロードしてください。無断の肖像・音声・著作物は禁止です。
          </li>
          <li>
            You own your uploads; you grant us a limited license to process them and render output. /
            アップロード素材の権利は利用者に帰属し、当サービスは処理・生成のための限定的ライセンスを受けるのみです。
          </li>
          <li>
            Check outputs yourself; accuracy or biases are not guaranteed. /
            生成結果の確認は利用者の責任で行ってください。正確性やバイアスは保証されません。
          </li>
          <li>
            Service may change or stop without notice; liability is limited to the extent permitted by
            law. / 予告なく機能変更・停止する場合があります。責任は法の許す範囲で限定されます。
          </li>
          <li>
            Data handling: uploadsや生成ログは機能提供・改善のために一時保存される場合があります。削除依頼がある場合はお知らせください。
          </li>
          <li>
            Age/eligibility: all ages may use; follow applicable laws in your region. /
            全年齢利用可ですが、各地域の法令を順守してください。
          </li>
        </ul>
      </section>
    </div>
  )
}

export default App
