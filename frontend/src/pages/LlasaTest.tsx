import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import './generate.css'
import './llasa.css'

type RunpodResponse = {
  id?: string
  request_id?: string
  status?: string
  output?: RunpodOutput | string | null
  error?: unknown
}

type RunpodOutput = {
  audio_b64?: string
  audio_url?: string
  prompt_text?: string
  status?: string
  error?: unknown
}

const RUNPOD_API_BASE = (import.meta.env.VITE_RUNPOD_API_BASE_URL || 'https://api.runpod.ai/v2').replace(/\/$/, '')
const RUNPOD_ENDPOINT_ID = import.meta.env.VITE_RUNPOD_ENDPOINT_ID || ''
const RUNPOD_ENDPOINT_BASE = (import.meta.env.VITE_RUNPOD_ENDPOINT_BASE_URL || '').replace(/\/$/, '')
const RUNPOD_API_KEY = import.meta.env.VITE_RUNPOD_API_KEY || ''

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 450

const ENDPOINT_BASE = RUNPOD_ENDPOINT_BASE || (RUNPOD_ENDPOINT_ID ? `${RUNPOD_API_BASE}/${RUNPOD_ENDPOINT_ID}` : '')

function normalizeError(value: unknown) {
  if (!value) return ''
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value && 'message' in value) {
    return String((value as { message?: string }).message || '')
  }
  return JSON.stringify(value)
}

function extractRequestId(payload: RunpodResponse) {
  if (!payload) return null
  if (payload.id) return payload.id
  if (payload.request_id) return payload.request_id
  const output = extractOutput(payload)
  if (output && typeof output === 'object') {
    const maybe = output as Record<string, unknown>
    if (typeof maybe.request_id === 'string') return maybe.request_id
  }
  return null
}

function extractOutput(payload: RunpodResponse): RunpodOutput | null {
  if (!payload) return null
  if (payload.output && typeof payload.output === 'object') return payload.output as RunpodOutput
  return payload as RunpodOutput
}

function extractStatus(payload: RunpodResponse) {
  const output = extractOutput(payload)
  return (payload.status || output?.status || '').toString()
}

function extractError(payload: RunpodResponse) {
  const output = extractOutput(payload)
  return normalizeError(payload.error) || normalizeError(output?.error)
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function base64ToObjectUrl(b64: string) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: 'audio/wav' })
  return URL.createObjectURL(blob)
}

function readNumber(raw: string, fallback: number) {
  const next = Number(raw)
  return Number.isFinite(next) ? next : fallback
}

export function LlasaTest() {
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null)
  const [promptText, setPromptText] = useState('')
  const [autoTranscribe, setAutoTranscribe] = useState(true)
  const [language, setLanguage] = useState('ja')
  const [targetText, setTargetText] = useState('')
  const [temperature, setTemperature] = useState(0.8)
  const [topP, setTopP] = useState(1.0)
  const [repetitionPenalty, setRepetitionPenalty] = useState(1.1)
  const [maxLength, setMaxLength] = useState(2048)
  const [stripPromptAudio, setStripPromptAudio] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [transcribedText, setTranscribedText] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)
  const referenceUrlRef = useRef<string | null>(null)
  const outputUrlRef = useRef<string | null>(null)

  const canGenerate = Boolean(referenceFile && targetText.trim()) && !isGenerating
  const endpointConfigured = Boolean(ENDPOINT_BASE)
  const usingProxy = Boolean(RUNPOD_ENDPOINT_BASE)
  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {}
    if (RUNPOD_API_KEY) headers.Authorization = `Bearer ${RUNPOD_API_KEY}`
    return headers
  }, [])

  const appendLog = (line: string) => {
    setLogLines((prev) => [...prev.slice(-180), `${new Date().toISOString()} ${line}`])
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
  }

  useEffect(() => {
    return () => {
      if (referenceUrlRef.current) URL.revokeObjectURL(referenceUrlRef.current)
      if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current)
    }
  }, [])

  const setOutputAudioUrl = (nextUrl: string) => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current)
    outputUrlRef.current = nextUrl
    setAudioUrl(nextUrl)
  }

  const setRemoteAudioUrl = (nextUrl: string) => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current)
    outputUrlRef.current = null
    setAudioUrl(nextUrl)
  }

  const handleReferenceChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (referenceUrlRef.current) URL.revokeObjectURL(referenceUrlRef.current)
    const previewUrl = URL.createObjectURL(file)
    referenceUrlRef.current = previewUrl
    setReferenceFile(file)
    setReferenceUrl(previewUrl)
    setPromptText('')
    setTranscribedText('')
  }

  const pollRunpod = async (id: string) => {
    if (!ENDPOINT_BASE) return null
    appendLog(`Polling /status/${id}`)
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      try {
        const res = await fetch(`${ENDPOINT_BASE}/status/${encodeURIComponent(id)}`, {
          headers: authHeaders,
        })
        const data = (await res.json()) as RunpodResponse
        const statusValue = extractStatus(data)
        if (statusValue) {
          setStatus(statusValue)
          appendLog(`status=${statusValue}`)
        }
        const errorValue = extractError(data)
        if (errorValue) {
          appendLog(`error=${errorValue}`)
          return null
        }
        const output = extractOutput(data)
        if (output?.audio_b64 || output?.audio_url) return output
        const normalized = statusValue.toUpperCase()
        if (['COMPLETED', 'FAILED', 'ERROR', 'CANCELLED'].includes(normalized)) {
          appendLog(`terminal status=${statusValue}`)
          return null
        }
      } catch (error) {
        appendLog(`poll error: ${normalizeError(error)}`)
      }
    }
    appendLog('poll timeout')
    return null
  }

  const handleGenerate = async () => {
    if (!ENDPOINT_BASE) {
      appendLog('RunPod endpoint is not configured.')
      return
    }
    if (!referenceFile) {
      appendLog('Reference audio is required.')
      return
    }
    if (!targetText.trim()) {
      appendLog('Target text is empty.')
      return
    }
    if (!RUNPOD_API_KEY && !usingProxy) {
      appendLog('RunPod API key is missing.')
      return
    }
    setIsGenerating(true)
    setStatus('submitting')
    setRequestId(null)
    setAudioUrl(null)
    setLogLines([])
    try {
      appendLog('Encoding reference audio...')
      const audioB64 = await fileToBase64(referenceFile)
      const payload = {
        text: targetText,
        prompt_text: promptText || undefined,
        prompt_audio_b64: audioB64,
        audio_filename: referenceFile.name,
        audio_mime: referenceFile.type,
        auto_transcribe: autoTranscribe,
        language,
        temperature,
        top_p: topP,
        repetition_penalty: repetitionPenalty,
        max_length: maxLength,
        strip_prompt_audio: stripPromptAudio,
      }
      appendLog('POST /run')
      const res = await fetch(`${ENDPOINT_BASE}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ input: payload }),
      })
      const data = (await res.json()) as RunpodResponse
      if (!res.ok) {
        appendLog(`run error: ${normalizeError(data.error) || res.statusText}`)
        return
      }
      const output = extractOutput(data)
      if (output?.audio_b64 || output?.audio_url) {
        appendLog('Audio received immediately.')
        if (output.prompt_text) {
          setTranscribedText(output.prompt_text)
          setPromptText((prev) => prev || output.prompt_text || '')
        }
        if (output.audio_b64) setOutputAudioUrl(base64ToObjectUrl(output.audio_b64))
        if (output.audio_url) setRemoteAudioUrl(output.audio_url)
        setStatus('completed')
        return
      }
      const nextId = extractRequestId(data)
      if (!nextId) {
        appendLog('No request_id returned.')
        return
      }
      setRequestId(nextId)
      setStatus('queued')
      const polled = await pollRunpod(nextId)
      if (!polled) return
      if (polled.prompt_text) {
        setTranscribedText(polled.prompt_text)
        setPromptText((prev) => prev || polled.prompt_text || '')
      }
      if (polled.audio_b64) setOutputAudioUrl(base64ToObjectUrl(polled.audio_b64))
      if (polled.audio_url) setRemoteAudioUrl(polled.audio_url)
      setStatus('completed')
    } catch (error) {
      appendLog(`run error: ${normalizeError(error)}`)
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="page llasa-page">
      <section className="hero">
        <p className="eyebrow">LLaSA 3B / RunPod</p>
        <h1>参考音声の声音で読み上げテスト</h1>
        <p className="lede">
          参考音声をアップロードし、読み上げたいテキストを入力して RunPod サーバーレスで推論します。
        </p>
        <div className="chips">
          <span className="chip">Endpoint: {ENDPOINT_BASE || '未設定'}</span>
          <span className="chip">API Key: {RUNPOD_API_KEY ? 'set' : 'unset'}</span>
          <span className="chip">Auto transcript: {autoTranscribe ? 'on' : 'off'}</span>
        </div>
        <div className="hero-actions">
          <Link className="ghost" to="/">
            Home
          </Link>
          <Link className="ghost" to="/generate">
            SoVITS Studio
          </Link>
        </div>
        {!endpointConfigured && <div className="error">RunPod エンドポイントが未設定です。</div>}
        {!RUNPOD_API_KEY && !usingProxy && (
          <div className="error">ブラウザから直接呼び出す場合は RunPod API key が必要です。</div>
        )}
      </section>

      <div className="grid">
        <div className="card">
          <div className="card-header">
            <h2>1. 参考音声</h2>
            <span className="status">upload</span>
          </div>
          <label className="upload-area">
            <input type="file" accept="audio/*" onChange={handleReferenceChange} />
            <div className="upload-title">音声ファイルを選択</div>
            <div className="upload-sub">WAV / MP3 / M4A など</div>
            <div className="upload-meta">{referenceFile?.name || '未選択'}</div>
          </label>
          {referenceUrl && (
            <div className="audio-output">
              <audio controls src={referenceUrl} />
            </div>
          )}
          <label className="field">
            <span>参考音声の文字起こし (任意)</span>
            <textarea
              rows={4}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="自動文字起こしを使う場合は空のまま"
            />
          </label>
          <div className="field inline">
            <label className="inline-field">
              <span>Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="ja">ja</option>
                <option value="en">en</option>
                <option value="zh">zh</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label className="inline-field toggle">
              <input
                type="checkbox"
                checked={autoTranscribe}
                onChange={(e) => setAutoTranscribe(e.target.checked)}
              />
              自動文字起こし
            </label>
          </div>
          {transcribedText && (
            <div className="transcript">
              <div className="transcript-title">Whisper 結果</div>
              <p>{transcribedText}</p>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>2. 読み上げテキスト</h2>
            <span className="status">input</span>
          </div>
          <label className="field">
            <span>Target text</span>
            <textarea
              rows={10}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              placeholder="読み上げたいテキストを入力"
            />
          </label>
          <details className="advanced">
            <summary>詳細パラメータ</summary>
            <div className="advanced-grid">
              <label className="field">
                <span>temperature</span>
                <input
                  type="number"
                  min="0.1"
                  max="2"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(readNumber(e.target.value, 0.8))}
                />
              </label>
              <label className="field">
                <span>top_p</span>
                <input
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={topP}
                  onChange={(e) => setTopP(readNumber(e.target.value, 1))}
                />
              </label>
              <label className="field">
                <span>repetition_penalty</span>
                <input
                  type="number"
                  min="1"
                  max="2"
                  step="0.05"
                  value={repetitionPenalty}
                  onChange={(e) => setRepetitionPenalty(readNumber(e.target.value, 1.1))}
                />
              </label>
              <label className="field">
                <span>max_length</span>
                <input
                  type="number"
                  min="256"
                  max="4096"
                  step="64"
                  value={maxLength}
                  onChange={(e) => setMaxLength(readNumber(e.target.value, 2048))}
                />
              </label>
              <label className="field toggle">
                <input
                  type="checkbox"
                  checked={stripPromptAudio}
                  onChange={(e) => setStripPromptAudio(e.target.checked)}
                />
                参照音声を出力に含めない
              </label>
            </div>
          </details>
          <div className="actions">
            <button type="button" className="primary" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? '生成中...' : '音声を生成'}
            </button>
          </div>
          {!canGenerate && <p className="muted">参照音声とテキストを入力してください。</p>}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>3. 出力</h2>
            <span className="status">{requestId ? `req ${requestId}` : status}</span>
          </div>
          {audioUrl ? (
            <div className="audio-output">
              <audio controls src={audioUrl} />
              <p className="muted">output: {audioUrl}</p>
            </div>
          ) : (
            <p className="muted">まだ音声はありません。</p>
          )}
          <div className="log-window" ref={logRef}>
            {logLines.length === 0 && <div className="muted">ログはまだありません。</div>}
            {logLines.map((line, idx) => (
              <div key={`${idx}-${line}`} className="log-line">
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
