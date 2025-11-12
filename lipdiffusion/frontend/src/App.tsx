import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { isAuthConfigured, supabase } from './lib/supabaseClient'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'https://api.lipdiffusion.uk'

type Service = {
  id: string
  label: string
  description: string
}

const SERVICES: Service[] = [
  {
    id: 'run-facefusion',
    label: 'FaceFusion',
    description: 'Video face swap + lip-sync pipeline',
  },
  {
    id: 'run-wav2lip',
    label: 'Wav2Lip',
    description: 'Lip-sync inference only',
  },
  {
    id: 'run-sovits',
    label: 'SoVITS (voice)',
    description: 'GPT-SoVITS text-to-speech',
  },
  {
    id: 'run-llama',
    label: 'LLaMA (text)',
    description: 'NSFW-tuned text model',
  },
]

const DEFAULT_PAYLOADS: Record<string, object> = {
  'run-facefusion': {
    facefusion: {
      source_key: 'uploads/source.png',
      target_key: 'uploads/target.mp4',
      processors: ['face_swapper', 'face_enhancer'],
    },
    wav2lip: {
      face_mode: 0,
    },
    audio_key: 'uploads/voice.wav',
  },
  'run-wav2lip': {
    face: 'uploads/target.mp4',
    audio: 'uploads/voice.wav',
    outfile: 'outputs/wav2lip/demo.mp4',
  },
  'run-sovits': {
    text: 'こんにちは、テストです。',
    ref_audio_key: 'uploads/reference.wav',
    target_language: 'ja',
  },
  'run-llama': {
    prompt: 'Summarise the latest run results in one sentence.',
    max_tokens: 120,
  },
}

const formatPayload = (service: string) =>
  JSON.stringify(DEFAULT_PAYLOADS[service] ?? {}, null, 2)

function App() {
  const [service, setService] = useState<string>(SERVICES[0]?.id ?? '')
  const [payload, setPayload] = useState(() => formatPayload(SERVICES[0]?.id ?? ''))
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [responseBody, setResponseBody] = useState<string>('Ready to run a test request.')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [session, setSession] = useState<Session | null>(null)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')

  const selectedService = useMemo(
    () => SERVICES.find((item) => item.id === service),
    [service],
  )

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

  const handleChangeService = (value: string) => {
    setService(value)
    setPayload(formatPayload(value))
    setResponseBody('Ready to run a test request.')
    setStatus('idle')
    setErrorMessage('')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setStatus('loading')
    setErrorMessage('')
    const body = payload

    try {
      JSON.parse(payload)
    } catch (err) {
      setStatus('error')
      setErrorMessage('Payload must be valid JSON before sending.')
      return
    }

    const endpoint = API_BASE_URL.replace(/\/$/, '') + '/' + service
    const accessToken = session?.access_token ?? ''

    if (!accessToken) {
      setStatus('error')
      setErrorMessage('ログイン後に API を呼び出せます。')
      return
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body,
      })

      const text = await response.text()
      setResponseBody(text || '[empty response]')

      if (!response.ok) {
        setStatus('error')
        setErrorMessage('Request failed with status ' + response.status)
        return
      }

      setStatus('success')
    } catch (error) {
      console.error(error)
      setStatus('error')
      setErrorMessage(
        error instanceof Error ? error.message : 'Unknown error while calling API',
      )
    }
  }

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Supabase の環境変数が設定されていません。')
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

        if (error) {
          throw error
        }

        setAuthStatus('success')
        setAuthMessage('確認メールを送信しました。受信箱を確認してください。')
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        })

        if (error) {
          throw error
        }

        setAuthStatus('success')
        setAuthMessage('ログインしました。')
      }
    } catch (error) {
      console.error(error)
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
      <header>
        <p className="eyebrow">lipdiffusion control panel</p>
        <h1>Trigger RunPod jobs from the browser</h1>
        <p className="lede">
          This lightweight dashboard lives on Cloudflare Pages and relays requests to your
          Cloudflare Worker gateway at <code>{API_BASE_URL}</code>.
        </p>
      </header>

      <section className="panel auth-panel">
        <div className="panel-header">
          <h2>User access</h2>
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
                <option value="signin">Sign in</option>
                <option value="signup">Create account</option>
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

      <form className="panel" onSubmit={handleSubmit}>
        <label className="field">
          <span>Choose service</span>
          <select value={service} onChange={(e) => handleChangeService(e.target.value)}>
            {SERVICES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} — {item.description}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Request payload (JSON)</span>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={12}
            spellCheck={false}
          />
          <small>
            These defaults mirror what each RunPod worker expects. Adjust keys before sending.
          </small>
        </label>

        {!isAuthenticated && (
          <p className="auth-warning">ログイン後にリクエストを送信できます。</p>
        )}

        <button type="submit" disabled={status === 'loading' || !isAuthenticated}>
          {status === 'loading' ? 'Sending…' : 'POST ' + service}
        </button>

        {selectedService && <p className="muted">{selectedService.description}</p>}

        {errorMessage && <p className="error">{errorMessage}</p>}
      </form>

      <section className="panel">
        <div className="panel-header">
          <h2>API response</h2>
          <span className={'status status-' + status}>{status}</span>
        </div>
        <pre className="response" aria-live="polite">
          {responseBody}
        </pre>
      </section>

      <section className="tips">
        <h3>Tips</h3>
        <ul>
          <li>RunPod jobs may take a while – check the status endpoint if needed.</li>
          <li>
            Update <code>DEFAULT_PAYLOADS</code> in <code>src/App.tsx</code> with real templates.
          </li>
          <li>
            During local dev, this UI hits <code>http://localhost:5173</code>. The Worker CORS
            policy already allows it.
          </li>
        </ul>
      </section>
    </div>
  )
}

export default App
