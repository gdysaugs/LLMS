import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const APP_URL = import.meta.env.VITE_APP_URL ?? 'https://app.lipdiffusion.uk'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')

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
