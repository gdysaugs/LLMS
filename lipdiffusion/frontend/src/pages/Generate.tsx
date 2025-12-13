import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, isAuthConfigured } from '../lib/supabaseClient'

type BillingStatus = {
  tickets: number
  subscription_status?: string | null
}

type TaskRecord = {
  status?: string
  state?: string
  stage?: string
  result?: any
  error?: any
}

const formatTime = () => {
  const now = new Date()
  return now.toLocaleTimeString(undefined, { hour12: false })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  backoffMs = 1200,
): Promise<Response> {
  let lastError: unknown = null
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      return res
    } catch (error) {
      lastError = error
      if (i < retries - 1) {
        const wait = backoffMs * (i + 1)
        await delay(wait)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'fetch failed'))
}

export function Generate() {
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)

  const API_BASE = useMemo(
    () => (import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'),
    [],
  )
  const API_GATEWAY_BASE = useMemo(
    () =>
      import.meta.env.VITE_API_GATEWAY_BASE_URL?.replace(/\/$/, '') ??
      API_BASE.replace(/\/fastapi$/, ''),
    [API_BASE],
  )
  const API_KEY = import.meta.env.VITE_API_KEY
  const TICKET_TOKEN = import.meta.env.VITE_TICKET_TOKEN

  const serviceHeaders = useMemo<Record<string, string>>(() => {
    if (!API_KEY) return {} as Record<string, string>
    const bearer = API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
    return {
      'X-Api-Key': API_KEY,
      Authorization: bearer,
    } as Record<string, string>
  }, [API_KEY])

  const [session, setSession] = useState<Session | null>(null)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingStatus, setBillingStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [billingMessage, setBillingMessage] = useState('')

  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [scriptText, setScriptText] = useState('')

  const [isRunning, setIsRunning] = useState(false)
  const [status, setStatus] = useState<'idle' | 'preparing' | 'uploading' | 'running' | 'success' | 'error'>('idle')
  const [error, setError] = useState<string>('')
  const [logs, setLogs] = useState<string[]>([])
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultObjectUrl, setResultObjectUrl] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)

  const appendLog = (message: string) => {
    setLogs((prev) => [...prev, `[${formatTime()}] ${message}`])
  }

  const proxyUrl = (url: string) => {
    if (!url) return url
    if (!API_GATEWAY_BASE) return url
    return `${API_GATEWAY_BASE}/r2-proxy?url=${encodeURIComponent(url)}`
  }

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => {
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const fetchBilling = async (activeSession: Session | null) => {
      if (!activeSession?.access_token) {
        setBilling(null)
        setBillingStatus('idle')
        setBillingMessage('')
        return
      }
      setBillingStatus('loading')
      setBillingMessage('')
      try {
        const res = await fetchWithRetry(API_BASE + '/billing/status', {
          headers: {
            Authorization: 'Bearer ' + activeSession.access_token,
          },
        })
        const data = await res.json()
        setBilling({
          tickets: Number(data?.tickets ?? 0),
          subscription_status: data?.subscription_status,
        })
        setBillingStatus('idle')
      } catch (err) {
        setBillingStatus('error')
        setBilling(null)
        setBillingMessage(
          err instanceof Error ? err.message : '課金ステータスを取得できませんでした。',
        )
      }
    }
    void fetchBilling(session)
  }, [API_BASE, session])

  useEffect(() => {
    return () => {
      if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl)
    }
  }, [resultObjectUrl])

  const presignUpload = async (file: File, prefix: string) => {
    const safeName = file.name.replace(/\s+/g, '-')
    const key = `${prefix}/${Date.now()}-${safeName}`
    const res = await fetchWithRetry(`${API_BASE}/storage/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...serviceHeaders,
      },
      body: JSON.stringify({
        intent: 'upload',
        key,
        content_type: file.type || 'application/octet-stream',
        expires_in: 900,
      }),
    })
    const data = await res.json()
    if (!data?.url || !data?.key) {
      throw new Error('署名付きURLの取得に失敗しました')
    }
    return { uploadUrl: data.url as string, key: data.key as string, publicUrl: data.public_url as string | undefined }
  }

  const uploadToPresigned = async (file: File, uploadUrl: string) => {
    const target =
      API_GATEWAY_BASE && uploadUrl.startsWith('http')
        ? `${API_GATEWAY_BASE}/r2-proxy?url=${encodeURIComponent(uploadUrl)}`
        : uploadUrl
    const put = await fetchWithRetry(
      target,
      {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      },
      3,
      1500,
    )
    return put
  }

  const warmupTarget = async (target: 'sovits' | 'wav2lip') => {
    try {
      await fetchWithRetry(`${API_BASE}/warmup?target=${target}`, { method: 'POST', headers: serviceHeaders }, 1, 400)
      appendLog(`${target.toUpperCase()} をウォームアップしました`)
    } catch {
      appendLog(`${target.toUpperCase()} ウォームアップに失敗しましたが続行します`)
    }
  }

  const consumeTicket = async (email: string): Promise<string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (TICKET_TOKEN) {
      headers['X-Ticket-Token'] = TICKET_TOKEN
    }
    if (session?.access_token) {
      headers.Authorization = 'Bearer ' + session.access_token
    }
    const res = await fetchWithRetry(`${API_BASE}/tickets/consume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, count: 1, reason: 'generate' }),
    })
    const data = await res.json()
    if (!data?.usage_id) {
      throw new Error('チケット消費に失敗しました')
    }
    appendLog('チケットを1枚消費しました')
    return data.usage_id as string
  }

  const refundTicket = async (usageId: string, reason = 'pipeline_failed') => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (TICKET_TOKEN) {
      headers['X-Ticket-Token'] = TICKET_TOKEN
    }
    if (session?.access_token) {
      headers.Authorization = 'Bearer ' + session.access_token
    }
    try {
      await fetchWithRetry(`${API_BASE}/tickets/refund`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ usage_id: usageId, reason }),
      })
      appendLog('チケットを払い戻しました')
    } catch (err) {
      appendLog('チケット払い戻しに失敗しました')
    }
  }

  const startPipeline = async (payload: Record<string, any>) => {
    const res = await fetchWithRetry(`${API_BASE}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...serviceHeaders,
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data?.task_id) return data.task_id as string
    if (data?.result?.output_url) return data.result.output_url as string
    throw new Error('ジョブ開始に失敗しました')
  }

  const pollTask = async (id: string): Promise<TaskRecord> => {
    let attempt = 0
    const maxAttempts = 240 // up to ~16 minutes
    while (attempt < maxAttempts) {
      const res = await fetchWithRetry(`${API_BASE}/status/${id}`, { headers: serviceHeaders }, 2, 1200)
      const data = (await res.json()) as TaskRecord
      const state = data.state || data.status
      if (state === 'completed') return data
      if (state === 'failed') throw new Error(data?.error?.detail || '生成ジョブが失敗しました')
      attempt += 1
      await delay(4000 + attempt * 100)
    }
    throw new Error('タイムアウトしました')
  }

  const extractOutputUrl = (record: TaskRecord): string | null => {
    const result = record.result || {}
    // Wav2Lip の出力 (H.264/mp4 想定) を最優先で使う
    return (
      result?.wav2lip?.output_url ||
      result?.wav2lip_output_url ||
      result?.presigned_url ||
      result.output_url ||
      result.public_url ||
      result.url ||
      result.mp4_url ||
      null
    )
  }

  const loadResultVideo = async (url: string) => {
    // プロキシ経由で取得し、blob URL を作って video に設定する（CORS/Range 回避）
    const proxied = proxyUrl(url)
    setResultUrl(url)
    try {
      const res = await fetchWithRetry(proxied ?? url, {}, 2, 1200)
      const blob = await res.blob()
      const obj = URL.createObjectURL(blob)
      setResultObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return obj
      })
      appendLog('生成動画をローカル再生用に読み込みました')
    } catch (err) {
      setResultObjectUrl(null)
      appendLog('動画を直接再生します（CORSで失敗した場合はリンクをクリックしてください）')
    }
  }

  const handleGenerate = async () => {
    setError('')
    setStatus('preparing')
    setResultUrl(null)
    setResultObjectUrl(null)
    setTaskId(null)

    if (!isAuthConfigured || !supabase) {
      setError('Supabase が未設定です。環境変数を確認してください。')
      setStatus('error')
      return
    }
    if (!session?.user) {
      setError('ログインが必要です。先にサインインしてください。')
      setStatus('error')
      return
    }
    if (!videoFile || !audioFile) {
      setError('動画と音声を両方アップロードしてください。')
      setStatus('error')
      return
    }
    if (!billing || billing.tickets <= 0) {
      setError('チケット残高がありません。Stripeで購入してください。')
      setStatus('error')
      return
    }

    setIsRunning(true)
    appendLog('生成を開始します')

    let usageId: string | null = null

    try {
      // Warmup: 即座に SoVITS、15秒後に Wav2Lip
      await warmupTarget('sovits')
      setTimeout(() => {
        void warmupTarget('wav2lip')
      }, 15000)
      setStatus('uploading')
      appendLog('R2 に動画をアップロードしています')
      const videoPresign = await presignUpload(videoFile, 'uploads/video')
      await uploadToPresigned(videoFile, videoPresign.uploadUrl)

      appendLog('R2 に音声をアップロードしています')
      const audioPresign = await presignUpload(audioFile, 'uploads/audio')
      await uploadToPresigned(audioFile, audioPresign.uploadUrl)

      setStatus('running')
      usageId = await consumeTicket(session.user.email ?? '')

      const payload: Record<string, any> = {
        target_key: videoPresign.key,
        audio_key: audioPresign.key,
        script_text: scriptText.trim() || undefined,
        source_keys: [],
        retain_intermediate: true,
      }
      appendLog('生成ジョブを送信します')
      const maybeTaskId = await startPipeline(payload)

      // If startPipeline returned a direct URL, treat as completed
      if (maybeTaskId.startsWith('http')) {
        setStatus('success')
        appendLog('生成が完了しました')
        await loadResultVideo(maybeTaskId)
        void fetchWithRetry(API_BASE + '/billing/status', {
          headers: { Authorization: 'Bearer ' + session.access_token },
        })
          .then((res) => res.json())
          .then((data) =>
            setBilling({
              tickets: Number(data?.tickets ?? billing?.tickets ?? 0),
              subscription_status: data?.subscription_status,
            }),
          )
          .catch(() => {})
        setIsRunning(false)
        return
      }

      setTaskId(maybeTaskId)
      appendLog(`ジョブID: ${maybeTaskId} を監視します`)

      const record = await pollTask(maybeTaskId)
      const outputUrl = extractOutputUrl(record)
      if (!outputUrl) {
        throw new Error('生成結果のURLが取得できませんでした')
      }
      setStatus('success')
      appendLog('生成が完了しました')
      await loadResultVideo(outputUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : '生成に失敗しました'
      setError(message)
      setStatus('error')
      appendLog(`エラー: ${message}`)
      if (usageId) {
        await refundTicket(usageId)
      }
    } finally {
      setIsRunning(false)
      // Refresh billing (best effort)
      if (session?.access_token) {
        try {
          const res = await fetchWithRetry(API_BASE + '/billing/status', {
            headers: {
              Authorization: 'Bearer ' + session.access_token,
            },
          })
          const data = await res.json()
          setBilling({
            tickets: Number(data?.tickets ?? 0),
            subscription_status: data?.subscription_status,
          })
        } catch {
          // ignore
        }
      }
    }
  }

  const isAuthenticated = Boolean(session?.user)
  const canGenerate = isAuthenticated && !isRunning

  return (
    <div className="generate-root">
      <header className="generate-header">
        <div className="logo">LipDiffusion Studio</div>
        <nav className="generate-nav">
          <a href="/">ホーム</a>
          <a href="/generate" aria-current="page">
            生成
          </a>
        </nav>
      </header>

      <main className="generate-main">
        <section className="panel">
          <div className="panel-header">
            <h2>ログイン / チケット</h2>
            <span className="pill">{isAuthenticated ? 'ログイン中' : '未ログイン'}</span>
          </div>
          {!isAuthConfigured && (
            <p className="error">
              Supabase が未設定です。Cloudflare Pages の環境変数 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
              を設定してください。
            </p>
          )}
          {!isAuthenticated ? (
            <p className="muted">サインインすると生成できます。トップのアカウント欄からログインしてください。</p>
          ) : billingStatus === 'loading' ? (
            <p className="muted">チケットを読み込み中...</p>
          ) : billingStatus === 'error' ? (
            <p className="error">{billingMessage}</p>
          ) : (
            <div className="ticket-row">
              <div className="stat">
                <div className="stat-label">チケット残高</div>
                <div className="stat-value">{billing?.tickets ?? 0} 枚</div>
              </div>
              <div className="stat">
                <div className="stat-label">サブスク</div>
                <div className="stat-value">{billing?.subscription_status ?? 'inactive'}</div>
              </div>
              <p className="muted">生成には毎回チケット1枚が必要です。失敗時は自動で払い戻します。</p>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>素材をアップロード</h2>
            <span className="pill">R2 アップロード → SoVITS → Wav2Lip</span>
          </div>
          <div className="upload-grid">
            <label className="upload-box">
              <span className="upload-title">ベース動画 (mp4/H.264 推奨)</span>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
              />
              <div className="upload-meta">
                {videoFile ? videoFile.name : 'クリックして動画を選択'}
              </div>
            </label>
            <label className="upload-box">
              <span className="upload-title">音声 (声質コピー用の参照)</span>
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
              />
              <div className="upload-meta">
                {audioFile ? audioFile.name : 'クリックして音声を選択'}
              </div>
            </label>
          </div>
          <div className="field">
            <label htmlFor="script-text">セリフ / 台本（SoVITS で合成して Wav2Lip に渡します）</label>
            <textarea
              id="script-text"
              placeholder="ここにセリフ／台本を入力してください"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              rows={4}
            />
          </div>
          <p className="muted">
            「生成」を押すと /warmup → R2 アップロード → /tickets/consume → /run → /status を順に実行します。
            failed to fetch が出た場合は自動リトライします。
          </p>
          <div className="actions">
            <button type="button" onClick={handleGenerate} disabled={!canGenerate}>
              {isRunning ? '生成中…' : '生成'}
            </button>
            {status === 'success' && <span className="pill pill-success">完了</span>}
            {status === 'error' && <span className="pill pill-error">エラー</span>}
          </div>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>進行ログ</h2>
            {taskId && <span className="pill">Task ID: {taskId}</span>}
          </div>
          <div className="status-log">
            {logs.length === 0 ? <p className="muted">ここに進行状況が表示されます。</p> : null}
            {logs.map((log, idx) => (
              <div key={idx} className="log-line">
                {log}
              </div>
            ))}
          </div>
        </section>

        {(resultUrl || resultObjectUrl) && (
          <section className="panel">
            <div className="panel-header">
              <h2>生成結果 (H.264/mp4)</h2>
              <span className="pill">再生専用</span>
            </div>
            <div className="result-video">
              <video
                src={resultObjectUrl ?? resultUrl ?? undefined}
                controls
                playsInline
                style={{ width: '100%', borderRadius: '14px' }}
              />
              <p className="muted">
                ソースURL: <a href={resultUrl ?? resultObjectUrl ?? '#'}>{resultUrl ?? resultObjectUrl}</a>
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
