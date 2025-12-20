import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

const HERO_CTA = '無数のキャラから好きなシチュエーション・設定を選んで、あなただけの名前を呼ぶASMRボイスを即生成。'
const HERO_SUB =
  '国内最高峰の日本語読み上げ技術で「濡れ声」「発音」まで完全再現。シナリオも毎回変わる、世界初のシチュエーションボイス体験。'

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

type Feature = { title: string; body: string; tag: string }

const FEATURES: Feature[] = [
  { title: '毎回シナリオが変わる', body: 'キャラ×性格×シチュの組み合わせで台本を自動生成。飽きない体験。', tag: 'Script' },
  { title: '名前呼び特化', body: 'あなたの名前を呼ぶセリフを前提に設計。没入感を最大化。', tag: 'ASMR' },
  { title: '濡れ声・発音まで再現', body: '国内最高峰の日本語読み上げで囁き・息遣いも再現。', tag: 'Voice' },
  { title: '即生成・即試聴', body: 'ブラウザだけで完結。生成→試聴→ダウンロードまで数クリック。', tag: 'Speed' },
]

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [billingMessage, setBillingMessage] = useState('')
  const [billingAction, setBillingAction] = useState<'idle' | 'loading'>('idle')
  const [billingStatus, setBillingStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [billingBalance, setBillingBalance] = useState<number | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    async function exchangeOAuthCode() {
      if (!supabase) return
      const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
      const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
      if (!hasCode || !hasState) return
      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href)
      if (error) {
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
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('確認メールを送信しました。')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('サインインしました。')
      }
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : '認証エラーが発生しました。')
    }
  }

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    const cookieOptions = `domain=.lipdiffusion.uk; path=/; max-age=0; SameSite=None; Secure`
    document.cookie = `user_email=; ${cookieOptions}`
    document.cookie = `sb_access_token=; ${cookieOptions}`
  }

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Supabase の環境変数が未設定です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: OAUTH_REDIRECT_URL },
      })
      if (error) throw error
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'Google ログインに失敗しました。')
    }
  }

  const handleStartSubscription = async () => {
    if (!session?.access_token) {
      setBillingMessage('ログインしてください。')
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
      if (!response.ok || !data?.url) throw new Error(data?.detail || '購入を開始できませんでした。')
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(error instanceof Error ? error.message : '購入を開始できませんでした。')
    } finally {
      setBillingAction('idle')
    }
  }

  useEffect(() => {
    const fetchBillingStatus = async () => {
      if (!session?.access_token) {
        setBillingStatus('idle')
        setBillingBalance(null)
        setSubscriptionStatus(null)
        setBillingMessage('')
        return
      }
      setBillingStatus('loading')
      setBillingMessage('')
      try {
        const res = await fetchWithRetry(API_BASE + '/billing/status', {
          headers: { Authorization: 'Bearer ' + session.access_token },
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.detail || '課金ステータス取得に失敗しました')
        setBillingBalance(typeof data?.tickets === 'number' ? data.tickets : null)
        setSubscriptionStatus(data?.subscription_status || null)
        setBillingStatus('success')
      } catch (error) {
        setBillingStatus('error')
        setBillingMessage(error instanceof Error ? error.message : '課金ステータス取得に失敗しました')
      }
    }
    void fetchBillingStatus()
  }, [session])

  const isAuthenticated = Boolean(session?.access_token)
  const userEmail = session?.user?.email ?? ''

  return (
    <div className="App">
      <div className="landing">
        <header className="hero">
          <div className="hero-copy">
            <p className="eyebrow">ASMR Situation Voice SaaS</p>
            <h1>あなたの名前を呼ぶ、世界初のシチュエーションボイス</h1>
            <p className="lede">{HERO_CTA}</p>
            <p className="lede">{HERO_SUB}</p>
            <div className="hero-actions">
              <a className="primary-link" href="/generate">
                今すぐ生成する
              </a>
              <button className="ghost" onClick={() => document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })}>
                ログイン / 登録へ
              </button>
            </div>
            <div className="chips">
              <span className="chip">名前呼び特化</span>
              <span className="chip">日本語ASMR</span>
              <span className="chip">シナリオ自動生成</span>
            </div>
            <p className="muted">
              {isAuthenticated ? `サインイン中: ${userEmail || 'unknown'}` : '生成にはログインとチケット/サブスクが必要です'}
            </p>
          </div>
          <div className="hero-card">
            <div className="card-image">
              <img src="/media/character.png" alt="サンプルキャラ" />
              <span className="badge">Sample Character</span>
            </div>
            <div className="card-body">
              <h3>陽菜 (サンプル)</h3>
              <p className="muted">性格: 優しく寄り添う幼なじみ / シチュ: 寝かしつけASMR</p>
              <audio controls src="/media/sample-voice.mp3" className="audio-player" />
              <div className="card-actions">
                <a className="primary-link" href="/generate">
                  この声で作る
                </a>
                <button className="ghost" onClick={() => document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })}>
                  ログインして続ける
                </button>
              </div>
            </div>
          </div>
        </header>

        <section className="features">
          <div className="section-header">
            <h2>なぜ没入できる？</h2>
            <p className="muted">名前呼び×シチュエーション×台本自動生成で、毎回新しいASMR体験。</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature-card">
                <span className="tag">{f.tag}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="cta-panel">
          <div>
            <h2>生成フローは3ステップ</h2>
            <ol className="muted">
              <li>キャラとシチュエーションを選ぶ（プリセット）</li>
              <li>LLMで台本を自動生成（毎回違うシナリオ）</li>
              <li>SoVITSで声真似ASMRを生成（名前呼び入り）</li>
            </ol>
          </div>
          <div className="cta-actions">
            <a className="primary-link" href="/generate">
              スタジオへ進む
            </a>
            <button className="ghost" onClick={() => document.getElementById('billing')?.scrollIntoView({ behavior: 'smooth' })}>
              プランを見る
            </button>
          </div>
        </section>

        <section id="billing" className="pricing">
          <div className="section-header">
            <h2>ログイン & サブスク / チケット</h2>
            <p className="muted">ログインするとチケット管理とサブスク購入が可能です。</p>
          </div>
          <div className="pricing-card">
            {isAuthenticated ? (
              <>
                <h3>現在のステータス</h3>
                <p className="muted">
                  サインイン中: {userEmail || session?.user?.id}
                  <br />
                  保有チケット: {billingBalance !== null ? `${billingBalance} 枚` : billingStatus === 'loading' ? '取得中...' : '不明'}
                  <br />
                  サブスク: {subscriptionStatus ? subscriptionStatus : '未契約'}
                </p>
                <div className="chip">サブスク契約中は使い放題</div>
                {billingMessage && <div className={billingStatus === 'error' ? 'error' : 'muted'}>{billingMessage}</div>}
              </>
            ) : (
              <>
                <h3>ログインしてチケット管理</h3>
                <p className="muted">ログイン後にサブスク/チケットを購入できます。</p>
                <button className="primary" onClick={handleStartSubscription} disabled={billingAction === 'loading'}>
                  {billingAction === 'loading' ? '起動中...' : 'サブスクを開始する'}
                </button>
                {billingMessage && <div className="error">{billingMessage}</div>}
              </>
            )}
          </div>
        </section>

        <section id="auth" className="auth-section">
          <div className="section-header">
            <h2>ログイン / 新規登録</h2>
            <p className="muted">メールとパスワード、またはGoogleでログインできます。</p>
          </div>
          <div className="auth-card">
            {isAuthenticated ? (
              <div className="authed">
                <p className="muted">サインイン中: {userEmail || session?.user?.id}</p>
                <div className="card-actions">
                  <a className="primary-link" href="/generate">
                    スタジオへ進む
                  </a>
                  <button className="ghost" onClick={handleStartSubscription}>
                    サブスク/チケットを見る
                  </button>
                  <button className="ghost" onClick={handleSignOut}>
                    サインアウト
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="auth-toggle">
                  <button className={authMode === 'signup' ? 'tab active' : 'tab'} onClick={() => setAuthMode('signup')}>
                    新規登録
                  </button>
                  <button className={authMode === 'signin' ? 'tab active' : 'tab'} onClick={() => setAuthMode('signin')}>
                    ログイン
                  </button>
                </div>
                <form onSubmit={handleAuthSubmit} className="auth-form">
                  <label>
                    メールアドレス
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required />
                  </label>
                  <label>
                    パスワード
                    <input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      required
                      minLength={6}
                    />
                  </label>
                  <button className="primary" type="submit" disabled={authStatus === 'loading'}>
                    {authStatus === 'loading' ? '送信中...' : authMode === 'signup' ? '登録する' : 'ログインする'}
                  </button>
                  <button className="ghost" type="button" onClick={handleGoogleSignIn}>
                    Googleでログイン
                  </button>
                  {authMessage && <div className={authStatus === 'error' ? 'error' : 'muted'}>{authMessage}</div>}
                </form>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
