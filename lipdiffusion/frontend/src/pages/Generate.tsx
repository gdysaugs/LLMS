import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase, isAuthConfigured } from '../lib/supabaseClient'
import './generate.css'

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

const formatLogTime = () => new Date().toLocaleTimeString(undefined, { hour12: false })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 台本の危険な記号や行頭番号を除去
const sanitizeScript = (text: string) => {
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[\d０-９]+[).、．]?\s*/, ''))
    .map((line) => line.replace(/[()（）［］\[\]{}【】<>＜＞『』「」]/g, ''))
    .map((line) => line.replace(/[!?！？…‥#:：；;＊*]/g, ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return cleanedLines.join('\n').trim()
}

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (error) {
      lastError = error
      if (i < retries - 1) await delay(backoffMs * (i + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'fetch failed'))
}

export function Generate() {
  const location = useLocation()

  const API_GATEWAY_BASE = useMemo(
    () => import.meta.env.VITE_API_GATEWAY_BASE_URL?.replace(/\/$/, '') ?? null,
    [],
  )
  const API_BASE = useMemo(() => {
    if (API_GATEWAY_BASE) return `${API_GATEWAY_BASE}/fastapi`
    return import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
  }, [API_GATEWAY_BASE])
  const API_KEY = import.meta.env.VITE_API_KEY

  const serviceHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {}
    if (API_KEY) headers.Authorization = API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
    return headers
  }, [API_KEY])

  const [session, setSession] = useState<Session | null>(null)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingStatus, setBillingStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [scriptText, setScriptText] = useState('')
  const [sovitsSpeed, setSovitsSpeed] = useState<number>(1.3)

  const [isRunning, setIsRunning] = useState(false)
  const [status, setStatus] = useState<
    'idle' | 'preparing' | 'uploading' | 'running' | 'success' | 'error'
  >('idle')
  const [error, setError] = useState<string>('')
  const [logs, setLogs] = useState<string[]>([])
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultObjectUrl, setResultObjectUrl] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [showPresets, setShowPresets] = useState(false)

  const audioPresets = [
    { label: '少年っぽい', url: '/presets/boy.m4a', filename: 'preset_boy.m4a' },
    { label: '可愛いクラスメイト', url: '/presets/cute_girl.wav', filename: 'preset_cute_girl.wav' },
    { label: 'お姉さん', url: '/presets/oneesan.m4a', filename: 'preset_oneesan.m4a' },
    { label: '高めの女性', url: '/presets/high_female.m4a', filename: 'preset_high_female.m4a' },
    { label: '低めの女性', url: '/presets/low_female.m4a', filename: 'preset_low_female.m4a' },
    { label: '泣き声ニュアンス', url: '/presets/nakigoe.mp3', filename: 'preset_nakigoe.mp3' },
    { label: '元気な子', url: '/presets/energetic_girl.mp3', filename: 'preset_energetic_girl.mp3' },
    { label: 'やんちゃ', url: '/presets/mesugaki.mp3', filename: 'preset_mesugaki.mp3' },
  ]

  const sampleCharacter = {
    name: 'ヒナ',
    traits: ['恥ずかしがり', 'クラスメイト', '本当はエロい', 'シャイだけど興味津々'],
    script: `（教室の放課後、少し赤面しながら）
ねえ……ちょっとだけ、私の声、聴いてくれる？
いつもは言えないけど、実は……こういうの、ずっと試してみたかったの。
あなたにだけ、こっそり打ち明けるから……優しく聞いてほしいな。
息を合わせて、ふたりだけの秘密みたいに、ゆっくり話すね。`,
    audioUrl: '/media/sample-voice.mp3',
    audioFile: 'sample_voice_hina.mp3',
  }

  const appendLog = (message: string) =>
    setLogs((prev) => [...prev, `[${formatLogTime()}] ${message}`])

  const proxyUrl = (url: string) => {
    if (!url) return url
    if (!API_GATEWAY_BASE) return url
    return `${API_GATEWAY_BASE}/r2-proxy?url=${encodeURIComponent(url)}`
  }

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession))
    return () => {
      data.subscription.unsubscribe()
    }
  }, [])

  const fetchBilling = async (activeSession: Session | null) => {
    if (!activeSession?.access_token) {
      setBilling(null)
      setBillingStatus('idle')
      return
    }
    setBillingStatus('loading')
    try {
      const res = await fetchWithRetry(API_BASE + '/billing/status', {
        headers: { Authorization: 'Bearer ' + activeSession.access_token },
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
    }
  }

  useEffect(() => {
    void fetchBilling(session)
  }, [API_BASE, session])

  useEffect(() => {
    const imported = (location.state as any)?.importedAudio as File | undefined
    if (imported) {
      setAudioFile(imported)
      appendLog(`音声ファイルを読み込みました (${imported.name})`)
    }
  }, [location.state])

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
    if (!data?.url || !data?.key) throw new Error('アップロードURLの取得に失敗しました')
    return { uploadUrl: data.url as string, key: data.key as string }
  }

  const uploadToPresigned = async (file: File, uploadUrl: string) => {
    const target =
      API_GATEWAY_BASE && uploadUrl.startsWith('http')
        ? `${API_GATEWAY_BASE}/r2-proxy?url=${encodeURIComponent(uploadUrl)}`
        : uploadUrl
    return fetchWithRetry(
      target,
      {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
      3,
      1500,
    )
  }

  const consumeTicket = async (email: string): Promise<string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token

    const res = await fetchWithRetry(`${API_BASE}/tickets/consume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, count: 1, reason: 'generate' }),
    })
    const data = await res.json()
    if (!data?.usage_id) throw new Error('チケット消費に失敗しました')
    appendLog('チケットを1枚消費しました')
    return data.usage_id as string
  }

  const refundTicket = async (usageId: string, reason = 'pipeline_failed') => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token
    try {
      await fetchWithRetry(`${API_BASE}/tickets/refund`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ usage_id: usageId, reason }),
      })
      appendLog('チケットをリファンドしました')
    } catch {
      appendLog('チケットのリファンドに失敗しました')
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
    throw new Error('生成ジョブの開始に失敗しました')
  }

  const pollTask = async (id: string): Promise<TaskRecord> => {
    let attempt = 0
    const maxAttempts = 240
    while (attempt < maxAttempts) {
      const res = await fetchWithRetry(`${API_BASE}/status/${id}`, { headers: serviceHeaders }, 2, 1200)
      const data = (await res.json()) as TaskRecord
      const state = data.state || data.status
      if (state === 'completed') return data
      if (state === 'failed') throw new Error(data?.error?.detail || 'ジョブが失敗しました')
      attempt += 1
      await delay(4000 + attempt * 100)
    }
    throw new Error('ジョブがタイムアウトしました')
  }

  const extractOutputUrl = (record: TaskRecord): string | null => {
    const result = record.result || {}
    return (
      result?.sovits?.output_url ||
      result?.presigned_url ||
      result.output_url ||
      result.public_url ||
      result.url ||
      result.mp3_url ||
      result.wav_url ||
      null
    )
  }

  const logStagesIfAvailable = (record: TaskRecord) => {
    const result = record.result || {}
    if (result?.sovits?.output_url) appendLog('音声合成ステージ完了')
  }

  const loadResultMedia = async (url: string) => {
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
      appendLog('結果ファイルを読み込みました')
    } catch {
      setResultObjectUrl(null)
      appendLog('結果の取得に失敗しました（直接リンクを開いてください）')
    }
  }

  const handlePreset = async (presetUrl: string, filename: string) => {
    try {
      const res = await fetch(presetUrl)
      const blob = await res.blob()
      const file = new File([blob], filename, { type: blob.type || 'audio/mp3' })
      setAudioFile(file)
      appendLog(`音声プリセットを読み込みました (${filename})`)
    } catch {
      appendLog('音声プリセットの読み込みに失敗しました')
    }
  }

  const previewPreset = (presetUrl: string) => {
    const audio = new Audio(presetUrl)
    void audio.play()
  }

  const handleSampleCharacter = async () => {
    setShowPresets(true)
    setScriptText(sampleCharacter.script)
    appendLog(`サンプルキャラ「${sampleCharacter.name}」の台本をセットしました`)
    try {
      await handlePreset(sampleCharacter.audioUrl, sampleCharacter.audioFile)
      appendLog('ヒナの音声プリセットを適用しました')
    } catch {
      // handled inside preset loader
    }
  }

  const handleGenerate = async () => {
    setError('')
    setStatus('preparing')
    setResultUrl(null)
    setResultObjectUrl(null)
    setTaskId(null)

    const sanitizedScript = sanitizeScript(scriptText || '')

    if (!isAuthConfigured || !supabase) {
      setError('Supabase が未設定です（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を確認）')
      setStatus('error')
      return
    }
    if (!session?.user) {
      setError('ログインしてください（ページ上部のログイン/登録ボタンから）')
      setStatus('error')
      return
    }
    if (!audioFile) {
      setError('音声ファイルを選択してください（プリセットでもOK）')
      setStatus('error')
      return
    }
    if (!billing || billing.tickets <= 0) {
      setError('チケット残高がありません。Stripeから購入・サブスクしてください。')
      setStatus('error')
      return
    }

    setIsRunning(true)
    appendLog('生成を開始します')

    let usageId: string | null = null

    try {
      setStatus('uploading')
      appendLog('音声をアップロード中...')
      const audioPresign = await presignUpload(audioFile, 'uploads/audio')
      await uploadToPresigned(audioFile, audioPresign.uploadUrl)

      setStatus('running')
      usageId = await consumeTicket(session.user.email ?? '')

      const payload: Record<string, any> = {
        audio_key: audioPresign.key,
        script_text: sanitizedScript || undefined,
        source_keys: [],
        retain_intermediate: true,
        sovits: { speed: sovitsSpeed, temperature: 1.0 },
      }
      appendLog('ジョブを開始しました')
      const maybeTaskId = await startPipeline(payload)

      if (maybeTaskId.startsWith('http')) {
        setStatus('success')
        appendLog('生成が完了しました')
        await loadResultMedia(maybeTaskId)
        setIsRunning(false)
        return
      }

      setTaskId(maybeTaskId)
      appendLog(`Task ID: ${maybeTaskId} を待機中...`)

      const record = await pollTask(maybeTaskId)
      logStagesIfAvailable(record)
      const outputUrl = extractOutputUrl(record)
      if (!outputUrl) throw new Error('出力URLが取得できませんでした')

      setStatus('success')
      appendLog('生成が完了しました')
      await loadResultMedia(outputUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : '生成に失敗しました'
      setError(message)
      setStatus('error')
      appendLog(`エラー: ${message}`)
      if (usageId) await refundTicket(usageId)
    } finally {
      setIsRunning(false)
      if (session?.access_token) {
        void fetchBilling(session)
      }
    }
  }

  const isAuthenticated = Boolean(session?.user)
  const canGenerate = isAuthenticated && !isRunning

  const ticketDisplay = (() => {
    if (!isAuthenticated) return '未ログイン'
    if (billingStatus === 'loading') return '残高確認中...'
    if (billingStatus === 'error') return '取得失敗'
    return `${billing?.tickets ?? 0} 枚`
  })()

  return (
    <div className="page">
      <div className="status-bar">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>ログイン: {isAuthenticated ? session?.user?.email ?? 'アカウント' : '未ログイン'}</span>
          <span>チケット: {ticketDisplay}</span>
          <span>サブスク: {billing?.subscription_status ?? 'inactive'}</span>
          <a className="chip" href="/#auth">
            ログイン / 登録
          </a>
          <a className="chip" href="/#billing">
            サブスク・チケット購入
          </a>
        </div>
      </div>

      <div className="hero">
        <p className="eyebrow">Audio Only Pipeline</p>
        <h1>音声だけで生成する /generate</h1>
        <p className="lede">動画入力は不要。音声と台本で SoVITS + LLaMA パイプラインを回します。</p>
        <div className="chips">
          <span className="chip">音声アップロード</span>
          <span className="chip">プリセット選択</span>
          <span className="chip">台本テキスト</span>
          <span className="chip">チケット消費: 1枚/回</span>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <div className="card-header">
            <h2>サンプルキャラで即試す</h2>
            <span className="chip">ヒナ / この声で作る</span>
          </div>
          <div className="chips" style={{ marginBottom: 10 }}>
            {sampleCharacter.traits.map((trait) => (
              <span key={trait} className="chip">
                {trait}
              </span>
            ))}
          </div>
          <p className="muted" style={{ whiteSpace: 'pre-line' }}>
            {sampleCharacter.script}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button type="button" className="primary" onClick={handleSampleCharacter}>
              ヒナの声で作る
            </button>
            <button type="button" onClick={() => previewPreset(sampleCharacter.audioUrl)}>
              サンプル音声を再生
            </button>
            <a className="chip" href="/#billing">
              サブスク / チケット購入へ
            </a>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>音声をアップロード / プリセット</h2>
            <span className="chip">音声のみ</span>
          </div>
          <div className="field">
            <label htmlFor="audio">音声 (無音でも可・SoVITSで合成)</label>
            <input
              id="audio"
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg"
              onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
            />
            <p className="muted">{audioFile ? audioFile.name : 'ファイルが選択されていません'}</p>
          </div>
          <div className="field">
            <button type="button" onClick={() => setShowPresets((v) => !v)} className="chip">
              {showPresets ? '▲ プリセットを閉じる' : '▼ プリセットから選ぶ'}
            </button>
            {showPresets && (
              <div className="grid two" style={{ marginTop: 8 }}>
                {audioPresets.map((preset) => (
                  <div key={preset.url} className="card" style={{ padding: 12 }}>
                    <div className="card-header">
                      <h3 style={{ margin: 0 }}>{preset.label}</h3>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="chip" onClick={() => handlePreset(preset.url, preset.filename)}>
                        この声を使う
                      </button>
                      <button type="button" className="chip" onClick={() => previewPreset(preset.url)}>
                        試聴
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="script">台本 / セリフ（数字・効果音・括弧は禁止）</label>
            <textarea
              id="script"
              placeholder="セリフをここに書くか、空欄でもOK（SoVITSのみ）"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              rows={4}
            />
            <p className="muted">
              行頭の番号・記号は自動で除去します。200行まで推奨、最大トークン3500相当。
            </p>
          </div>
          <div className="field">
            <label htmlFor="speed">話速 (1.3 - 2.0 推奨: 1.3)</label>
            <input
              id="speed"
              type="range"
              min="1.3"
              max="2"
              step="0.1"
              value={sovitsSpeed}
              onChange={(e) => setSovitsSpeed(parseFloat(e.target.value))}
            />
            <div className="muted">現在: {sovitsSpeed.toFixed(1)}x</div>
          </div>
          <div className="field" style={{ gap: 10 }}>
            <button type="button" className="primary" onClick={handleGenerate} disabled={!canGenerate}>
              {isRunning ? '生成中...' : 'この内容で生成する'}
            </button>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className={`status ${status === 'success' ? 'success' : status === 'error' ? 'error' : 'loading'}`}>
                {status}
              </span>
              {taskId && <span className="chip">Task ID: {taskId}</span>}
            </div>
            {error && <p className="error">{error}</p>}
            {!isAuthenticated && <p className="error">ログインが必要です。上部のログイン/登録から。</p>}
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="card-header">
            <h2>ステータス / ログ</h2>
          </div>
          <div className="log-window">
            {logs.length === 0 && <p className="muted">まだログはありません</p>}
            {logs.map((line, idx) => (
              <div key={idx} className="log-line">
                {line}
              </div>
            ))}
          </div>
        </div>

        {(resultUrl || resultObjectUrl) && (
          <div className="card">
            <div className="card-header">
              <h2>生成結果 (音声)</h2>
            </div>
            <div className="audio-output">
              <audio
                src={resultObjectUrl ?? resultUrl ?? undefined}
                controls
                style={{ width: '100%', maxWidth: 420, display: 'block', margin: '0 auto' }}
              />
              <p className="muted" style={{ marginTop: 8 }}>
                配布URL: {resultUrl ? <a href={resultUrl}>{resultUrl}</a> : '未取得'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
