import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
const defaultAvatar = '/media/default-avatar.png'

type Feature = { title: string; body: string; tag: string }
type CharacterCard = {
  id: string
  name: string
  caption: string
  image: string
  vibe: string
  scene: string
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

const FEATURES: Feature[] = [
  { title: '台本もワンボタン', body: 'キャラとシーンを選ぶだけ。Llama がモノローグ台本を即生成。', tag: 'Script' },
  { title: '声質コピー ASMR', body: 'GPT-SoVITS で参照音声のトーンをそのまま。吐息多めのささやきもOK。', tag: 'Voice' },
  { title: '最短ステップ', body: 'プロンプト記入なし。シナリオ → 合成 → 再生まで1画面で完結。', tag: 'Speed' },
]

const CHARACTERS: CharacterCard[] = [
  {
    id: 'hina',
    name: '陽菜',
    caption: '優しくてシャイな後輩',
    image: '/media/hina.png',
    vibe: '柔らかい囁きで甘やかす',
    scene: '放課後の教室 / 密着シチュ',
  },
  {
    id: 'rion',
    name: 'リオン',
    caption: '強気な同級生',
    image: '/media/rion.png',
    vibe: 'ズバッと速いテンポ、荒めの口調',
    scene: 'エッチ中 / 挑発的に責める',
  },
]

function App() {
  const navigate = useNavigate()
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
  const userAvatar = useMemo(() => {
    const raw = ((session?.user?.user_metadata as any)?.avatar_url as string | undefined) || ''
    if (!raw || raw.includes('googleusercontent.com')) return defaultAvatar
    return raw
  }, [session])

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
      setAuthMessage('Supabase の設定が未完了です')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    try {
      if (authMode === 'signup') {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('確認メールを送信しました。受信トレイをチェックしてください。')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
        if (error) throw error
        setAuthStatus('success')
        setAuthMessage('サインインしました。')
      }
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : '認証に失敗しました')
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
      setAuthMessage('Supabase の設定が未完了です')
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
      setAuthMessage(error instanceof Error ? error.message : 'Google でのログインに失敗しました')
    }
  }

  const handleStartSubscription = async () => {
    if (!session?.access_token) {
      setBillingMessage('ログインしてから購入してください')
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
      if (!response.ok || !data?.url) throw new Error(data?.detail || '決済ページを開けませんでした')
      window.location.assign(data.url as string)
    } catch (error) {
      setBillingMessage(error instanceof Error ? error.message : '決済を開始できませんでした')
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
        if (!res.ok) throw new Error(data?.detail || 'ステータス取得に失敗しました')
        setBillingBalance(typeof data?.tickets === 'number' ? data.tickets : null)
        setSubscriptionStatus(data?.subscription_status || null)
        setBillingStatus('success')
      } catch (error) {
        setBillingStatus('error')
        setBillingMessage(error instanceof Error ? error.message : 'ステータス取得に失敗しました')
      }
    }
    void fetchBillingStatus()
  }, [session])

  const isAuthenticated = Boolean(session?.access_token)
  const userEmail = session?.user?.email ?? ''
  const goProfile = () => navigate('/profile')

  const openCharacter = (id: string) => navigate(`/generate?character=${id}`)

  return (
    <div className="app-shell">
      <div className="bg-blur" />
      <div className="bg-grid" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">LD</span>
          <div>
            <div className="brand-title">LipDiffusion</div>
            <div className="brand-sub">ASMR Voice Studio</div>
          </div>
        </div>
        <nav className="nav-links">
          <Link to="/generate">Studio</Link>
          <a href="#characters">Characters</a>
          <a href="#auth">Account</a>
          <a href="#how">How to</a>
        </nav>
        {isAuthenticated ? (
          <div className="top-actions">
            <button className="ghost" onClick={() => openCharacter('hina')}>
              スタジオへ
            </button>
            <button className="avatar-btn" onClick={goProfile}>
              <img
                src={userAvatar}
                alt="avatar"
                onError={(e) => {
                  if (e.currentTarget.src !== defaultAvatar) e.currentTarget.src = defaultAvatar
                }}
              />
              <span className="avatar-name">{userEmail || 'Account'}</span>
            </button>
          </div>
        ) : (
          <div className="top-actions">
            <button className="ghost" onClick={() => document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })}>
              ログイン
            </button>
            <button className="primary" onClick={() => openCharacter('hina')}>
              すぐに生成
            </button>
          </div>
        )}
      </header>

      <section className="hero-crush">
        <div className="hero-copy">
          <p className="eyebrow">恋人みたいに話す AI キャラ</p>
          <h1>推しキャラの囁き声を、そのまま自分だけのASMRに。</h1>
          <p className="lede">
            crushon っぽいUIで、キャラカードから即ボイス生成。台本・声質コピー・再生まで1ページ完結。
          </p>
          <div className="hero-pills">
            <span className="pill">LLM 台本</span>
            <span className="pill">SoVITS Voice</span>
            <span className="pill">Ref-free</span>
            <span className="pill">R2 固定参照</span>
          </div>
          <div className="hero-cta">
            <button className="primary" onClick={() => openCharacter('rion')}>
              リオンで試す
            </button>
            <button className="ghost" onClick={() => openCharacter('hina')}>
              陽菜で試す
            </button>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-card">
            <div className="tag">ASMR Studio</div>
            <h3>キャラを選ぶ → 台本 → 声真似</h3>
            <p className="muted">声質コピー / 低遅延で即再生</p>
            <div className="hero-stack">
              {CHARACTERS.map((c) => (
                <div key={c.id} className="hero-avatar" onClick={() => openCharacter(c.id)}>
                  <img src={c.image} alt={c.name} />
                  <div className="avatar-meta">
                    <strong>{c.name}</strong>
                    <span>{c.caption}</span>
                  </div>
                </div>
              ))}
            </div>
            <button className="text-link" onClick={() => openCharacter('hina')}>
              スタジオを開く →
            </button>
          </div>
        </div>
      </section>

      <section id="characters" className="panel characters">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Characters</p>
            <h2>カードから推しを選んで、そのまま生成へ。</h2>
            <p className="muted">crushon.ai みたいにキャラ中心のUI。タップすると /generate がプリセット付きで開きます。</p>
          </div>
        </div>
        <div className="card-grid">
          {CHARACTERS.map((c) => (
            <div key={c.id} className="character-card">
              <div className="thumb">
                <img src={c.image} alt={c.name} />
                <span className="chip">{c.caption}</span>
              </div>
              <div className="card-body">
                <div className="card-title">
                  <h3>{c.name}</h3>
                  <span className="muted">{c.scene}</span>
                </div>
                <p className="muted">{c.vibe}</p>
                <div className="card-actions">
                  <button className="primary" onClick={() => openCharacter(c.id)}>
                    このキャラで話す
                  </button>
                  <button className="ghost" onClick={() => openCharacter(c.id)}>
                    詳細なしですぐ行く
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="panel flow">
        <div className="panel-head">
          <div>
            <p className="eyebrow">How it works</p>
            <h2>3クリックでASMR完成</h2>
          </div>
          <button className="text-link" onClick={() => openCharacter('hina')}>
            スタジオへ →
          </button>
        </div>
        <div className="steps">
          <div className="step-card">
            <span className="step-number">1</span>
            <h3>キャラを選ぶ</h3>
            <p>カードをクリックするとプリセット付きで /generate が開きます。</p>
          </div>
          <div className="step-card">
            <span className="step-number">2</span>
            <h3>台本を自動生成</h3>
            <p>Llama がシーンに沿ったモノローグ台本を生成。編集もOK。</p>
          </div>
          <div className="step-card">
            <span className="step-number">3</span>
            <h3>声質コピーで合成</h3>
            <p>固定参照音声を使い、GPT-SoVITS が即座にASMR音声を返します。</p>
          </div>
        </div>
      </section>

      <section className="panel features">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Why LipDiffusion</p>
            <h2>crushon風の見た目で、ASMR特化の中身。</h2>
          </div>
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

      <section id="auth" className="panel auth-section">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Account / Subscription</p>
            <h2>ログインとチケット確認</h2>
            <p className="muted">右のボタンからログイン。サブスク購入もここから。</p>
          </div>
        </div>
        <div className="auth-grid">
          <div className="auth-card">
            {isAuthenticated ? (
              <>
                <div className="auth-status">
                  <p className="muted">ログイン中</p>
                  <h3>{userEmail || session?.user?.id}</h3>
                </div>
                <div className="billing">
                  <div className="billing-row">
                    <span className="muted">チケット</span>
                    <strong>
                      {billingStatus === 'loading'
                        ? '読み込み中...'
                        : billingBalance !== null
                          ? `${billingBalance} 枚`
                          : '未取得'}
                    </strong>
                  </div>
                  <div className="billing-row">
                    <span className="muted">サブスク</span>
                    <strong>{subscriptionStatus || '未契約'}</strong>
                  </div>
                </div>
                {billingMessage && <div className="error">{billingMessage}</div>}
                <div className="card-actions">
                  <button className="primary" onClick={handleStartSubscription} disabled={billingAction === 'loading'}>
                    {billingAction === 'loading' ? '遷移中...' : 'サブスク / チケット購入'}
                  </button>
                  <button className="ghost" onClick={handleSignOut}>
                    サインアウト
                  </button>
                </div>
              </>
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
          <div className="cta-card">
            <p className="eyebrow">Ready?</p>
            <h3>キャラカードからすぐにスタジオへ。</h3>
            <p className="muted">/generate で台本と合成を一気に試せます。</p>
            <button className="primary" onClick={() => openCharacter('hina')}>
              スタジオを開く
            </button>
            <button className="ghost" onClick={() => document.getElementById('characters')?.scrollIntoView({ behavior: 'smooth' })}>
              キャラを見る
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default App
