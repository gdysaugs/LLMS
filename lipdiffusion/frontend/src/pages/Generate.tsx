import { useEffect, useMemo, useState } from 'react'
import './generate.css'

type TaskRecord = {
  status?: string
  state?: string
  stage?: string
  output?: any
  result?: any
  error?: any
}

const formatLogTime = () => new Date().toLocaleTimeString(undefined, { hour12: false })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sanitizeScript = (text: string) => {
  const cleaned = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[\d０-９]+[).、．]?\s*/, ''))
    .map((line) => line.replace(/[()（）［］\[\]{}【】<>＜＞『』「」]/g, ''))
    .map((line) => line.replace(/[!?！？…‥#:：；;＊*]/g, ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return cleaned.join('\n').trim()
}

const defaultModelPath = '/opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf'

export function Generate() {
  const API_GATEWAY_BASE = useMemo(
    () => import.meta.env.VITE_API_GATEWAY_BASE_URL?.replace(/\/$/, '') ?? null,
    [],
  )
  const API_BASE = useMemo(() => {
    if (API_GATEWAY_BASE) return `${API_GATEWAY_BASE}/fastapi`
    return import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
  }, [API_GATEWAY_BASE])
  const API_KEY = import.meta.env.VITE_API_KEY

  const [character, setCharacter] = useState({
    name: '陽菜',
    role: '優しく寄り添う幼なじみ',
    traits: 'ポジティブ・茶目っ気がある・ユーザーを否定しない',
    style: '語尾は柔らかく、吐息や囁きは括弧内で。絵文字なし。',
    boundaries: '暴言は避ける。センシティブな話題は受け流し、安心させる。',
    listener: 'あなた',
    scenario: '眠りにつく前にリラックスさせるASMR',
  })
  const [paragraphs, setParagraphs] = useState(6)
  const [scriptHint, setScriptHint] = useState('甘やかし系の囁きで、寝かしつける台本を作って。')
  const [scriptText, setScriptText] = useState('')
  const [llamaStatus, setLlamaStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [llamaTemp, setLlamaTemp] = useState(0.85)

  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadedKey, setUploadedKey] = useState<string | null>(null)
  const [uploadedPublicUrl, setUploadedPublicUrl] = useState<string | null>(null)

  const [sovitsStatus, setSovitsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [sovitsMessage, setSovitsMessage] = useState('')
  const [sovitsSpeed, setSovitsSpeed] = useState<number>(1.2)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultObjectUrl, setResultObjectUrl] = useState<string | null>(null)

  const [logs, setLogs] = useState<string[]>([])

  const appendLog = (message: string) =>
    setLogs((prev) => [...prev, `[${formatLogTime()}] ${message}`].slice(-200))

  useEffect(() => {
    return () => {
      if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl)
    }
  }, [resultObjectUrl])

  const ensureApiKey = () => {
    if (!API_KEY) throw new Error('VITE_API_KEY が未設定です (X-Api-Key/Bearer 用)')
    return API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
  }

  const buildPrompt = () => {
    const c = character
    return `You are ${c.name}, ${c.role}.
Persona: ${c.traits}
Speaking style: ${c.style}
Safety: ${c.boundaries}
Listener name: ${c.listener}
Scenario: ${c.scenario}
Task: Write a Japanese ASMR voice script spoken by ${c.name} toward ${c.listener}.
Rules:
- ${paragraphs} 行のセリフのみを改行で並べる。必ず ${paragraphs} 行出し切るまで終わらない。空行は禁止。
- 各行は1文だけ。行頭に数字・記号・行番号を付けない。数字は行頭以外なら可。
- 心の声・効果音・括弧やト書き・メタな締め文は一切禁止。END や 「終わり」も禁止。
- 他の登場人物やリスナーのセリフは書かない。モノローグのみ。
- 句読点以外の記号・絵文字（♡♪★など）や括弧類（()[]{}<>『』〝〟）は使わない。
- 漢字を減らし、できるだけひらがな・カタカナ中心で書く。
- 翻訳やローマ字は書かない。行数に到達したらそのまま終了する.
Do not break character. Do not include translation or romaji.`
  }

  const fetchWithRetry = async (url: string, options: RequestInit, retries = 3, backoff = 1200) => {
    let last: unknown = null
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, options)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res
      } catch (err) {
        last = err
        if (i < retries - 1) await wait(backoff * (i + 1))
      }
    }
    throw last instanceof Error ? last : new Error(String(last ?? 'fetch failed'))
  }

  const runLlama = async () => {
    setLlamaStatus('loading')
    setResultUrl(null)
    setTaskId(null)
    appendLog('LLM: 生成を開始します')

    const prompt = buildPrompt()
    const maxTokens = Math.min(3500, Math.max(800, paragraphs * 320))
    const llamaUrl = API_GATEWAY_BASE
      ? `${API_GATEWAY_BASE}/run-llama`
      : `${API_BASE}/run-llama`

    const body = {
      input: {
        prompt,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `目標: ${scriptHint}\n長さ: ${paragraphs}段落で短く。` },
        ],
        max_tokens: maxTokens,
        temperature: llamaTemp,
        model: defaultModelPath,
        model_path: defaultModelPath,
      },
    }

    try {
      const res = await fetchWithRetry(llamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: ensureApiKey() },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      const text =
        (json.output?.text as string) ||
        (json.output?.result as string) ||
        (json.result as string) ||
        (json.choices?.[0]?.message?.content as string) ||
        ''

      if (text) {
        const cleaned = sanitizeScript(text)
        const finalScript = cleaned || text || prompt
        setScriptText(finalScript)
        setLlamaStatus('success')
        appendLog('LLM: 生成完了')
        return
      }

      const jobId = json.id || json.jobId || json.job_id
      if (jobId) {
        appendLog(`LLM: ジョブ待機中 id=${jobId}`)
        const statusUrl = llamaUrl.replace(/\/run-llama$/, `/run-llama/status/${jobId}`)
        for (let i = 0; i < 120; i++) {
          const st = await fetch(statusUrl, { headers: { Authorization: ensureApiKey() } })
          const sj = await st.json()
          const content =
            (sj.output?.text as string) ||
            (sj.output?.result as string) ||
            (sj.result as string) ||
            (sj.choices?.[0]?.message?.content as string) ||
            ''
          if (content) {
            const cleaned = sanitizeScript(content)
            const finalScript = cleaned || content || prompt
            setScriptText(finalScript)
            setLlamaStatus('success')
            appendLog('LLM: 完了 (polling)')
            return
          }
          const state = String(sj.state || sj.status || 'running').toLowerCase()
          appendLog(`LLM: 状態=${state}`)
          if (state.includes('fail')) throw new Error('LLM ジョブが失敗しました')
          await wait(2000)
        }
        throw new Error('LLM 完了待ちがタイムアウトしました')
      }

      throw new Error('LLM 応答が空でした')
    } catch (err) {
      setLlamaStatus('error')
      const msg = err instanceof Error ? err.message : '生成に失敗しました'
      appendLog(`LLM: エラー ${msg}`)
      setScriptText('')
    }
  }

  const presignUpload = async (file: File) => {
    const key = `uploads/audio/${Date.now()}-${file.name.replace(/\s+/g, '-')}`
    const res = await fetchWithRetry(`${API_BASE}/storage/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: ensureApiKey(),
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
    return data as { url: string; key: string; public_url?: string }
  }



  const ensureUploaded = async () => {
    if (uploadedKey) return { key: uploadedKey, public_url: uploadedPublicUrl }
    if (!audioFile) throw new Error('参照音声ファイルを選択してください')
    setUploadStatus('loading')
    setUploadMessage('参照音声をアップロード中...')
    appendLog('R2: presign発行 (自動)')
    const presign = await presignUpload(audioFile)
    appendLog(`R2: PUT ${presign.key}`)
    await uploadToPresigned(audioFile, presign.url)
    setUploadedKey(presign.key)
    setUploadedPublicUrl(presign.public_url ?? null)
    setUploadStatus('success')
    setUploadMessage('アップロード完了')
    appendLog('R2: アップロード完了 (自動)')
    return { key: presign.key, public_url: presign.public_url }
  }
  const uploadToPresigned = async (file: File, url: string) => {
    const target =
      API_GATEWAY_BASE && url.startsWith('http')
        ? `${API_GATEWAY_BASE}/r2-proxy?url=${encodeURIComponent(url)}`
        : url
    await fetchWithRetry(target, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  }

  const handleUpload = async () => {
    if (!audioFile) {
      setUploadStatus('error')
      setUploadMessage('参照音声ファイルを選択してください')
      return
    }
    try {
      setUploadStatus('loading')
      setUploadMessage('参照音声をアップロード中...')
      appendLog('R2: presign発行')
      const presign = await presignUpload(audioFile)
      appendLog(`R2: PUT ${presign.key}`)
      await uploadToPresigned(audioFile, presign.url)
      setUploadedKey(presign.key)
      setUploadedPublicUrl(presign.public_url ?? null)
      setUploadStatus('success')
      setUploadMessage('アップロード完了')
      appendLog('R2: アップロード完了')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'アップロードに失敗しました'
      setUploadStatus('error')
      setUploadMessage(msg)
      appendLog(`R2: エラー ${msg}`)
    }
  }

  const extractOutputUrl = (record: TaskRecord) => {
    const r = record.result || record.output || record
    return (
      r?.sovits?.output_url ||
      r?.output_url ||
      r?.public_url ||
      r?.presigned_url ||
      r?.url ||
      r?.mp3_url ||
      r?.wav_url ||
      null
    )
  }

  const pollSovits = async (id: string) => {
    const statusUrl = API_GATEWAY_BASE
      ? `${API_GATEWAY_BASE}/run-sovits/status/${id}`
      : `${API_BASE}/run-sovits/status/${id}`
    for (let i = 0; i < 240; i++) {
      const res = await fetchWithRetry(statusUrl, { headers: { Authorization: ensureApiKey() } }, 2, 1200)
      const json = (await res.json()) as TaskRecord
      const state = String(json.state || json.status || 'running').toLowerCase()
      appendLog(`SoVITS: 状態 ${state}`)
      const url = extractOutputUrl(json)
      if (url) return url
      if (state.includes('fail')) throw new Error(json.error?.detail || 'ジョブが失敗しました')
      await wait(4000 + i * 100)
    }
    throw new Error('ジョブがタイムアウトしました')
  }

  const handleSovits = async () => {
    const cleanedScript = sanitizeScript(scriptText || '')
    if (!cleanedScript) {
      setSovitsStatus('error')
      setSovitsMessage('台本テキストを用意してください（空欄不可）')
      return
    }

    try {
      setSovitsStatus('loading')
      setSovitsMessage('SoVITSに送信中...')
      setResultUrl(null)
      setResultObjectUrl(null)
      setTaskId(null)
      appendLog('SoVITS: リクエスト送信')

      const uploaded = await ensureUploaded()

      const payload = {
        input: {
          reference_audio_key: uploaded.key,
          target_text: cleanedScript,
          reference_text: undefined,
          ref_text_free: true,
          output_key: `outputs/sovits/${Date.now()}.wav`,
          options: {
            target_language: 'ja',
            ref_language: 'ja',
            speed: sovitsSpeed,
            top_p: 1,
            temperature: 1,
            pause_second: 0.4,
            sample_steps: 8,
            cut: 'punctuation',
            with_prosody: false,
            output_prefix: 'outputs/sovits',
          },
        },
      }

      const sovitsUrl = API_GATEWAY_BASE
        ? `${API_GATEWAY_BASE}/run-sovits`
        : `${API_BASE}/run-sovits`

      const res = await fetchWithRetry(sovitsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ensureApiKey(),
        },
        body: JSON.stringify(payload),
      })

      const json = await res.json()
      const url = extractOutputUrl(json)
      if (url) {
        setResultObjectUrl(null)
        setResultUrl(url)
        setSovitsStatus('success')
        setSovitsMessage('音声生成が完了しました')
        appendLog('SoVITS: 完了(同期レスポンス)')
        return
      }

      const id = json.id || json.jobId || json.job_id
      if (id) {
        setTaskId(id)
        appendLog(`SoVITS: ジョブID ${id}`)
        const finalUrl = await pollSovits(id)
        setResultObjectUrl(null)
        setResultUrl(finalUrl)
        setSovitsStatus('success')
        setSovitsMessage('音声生成が完了しました')
        appendLog('SoVITS: 完了(ステータス)')
        return
      }

      throw new Error('出力URLが取得できませんでした')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合成に失敗しました'
      setSovitsStatus('error')
      setSovitsMessage(msg)
      appendLog(`SoVITS: エラー ${msg}`)
    }
  }

  const promptPreview = buildPrompt()

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">ASMR Voice Studio</p>
          <h1>キャラ設定 → 台本生成 → 声真似合成を1画面で</h1>
          <p className="lede">
            Llama で性格とシーンに沿った台本を作り、GPT-SoVITS(ref-free対応)で参照音声の声質をコピーしたASMR音声を生成します。
          </p>
        </div>
        <div className="chips">
          <span className="chip">LLM: llama-worker(Q6)</span>
          <span className="chip">Voice: SoVITS ref-free10</span>
          <span className="chip">R2 presign 対応</span>
        </div>
      </header>

      <div className="grid">
        <section className="card">
          <div className="card-header">
            <h2>1. キャラクター設定</h2>
            <span className="muted">システムプロンプトに反映</span>
          </div>
          <label className="field">
            <span>キャラ名</span>
            <input
              value={character.name}
              onChange={(e) => setCharacter({ ...character, name: e.target.value })}
              placeholder="例: 陽菜"
            />
          </label>
          <label className="field">
            <span>役割 / ポジション</span>
            <input
              value={character.role}
              onChange={(e) => setCharacter({ ...character, role: e.target.value })}
              placeholder="例: 優しく寄り添う幼なじみ"
            />
          </label>
          <label className="field">
            <span>性格・特徴</span>
            <textarea
              value={character.traits}
              onChange={(e) => setCharacter({ ...character, traits: e.target.value })}
              rows={2}
            />
          </label>
          <label className="field">
            <span>話し方スタイル</span>
            <textarea
              value={character.style}
              onChange={(e) => setCharacter({ ...character, style: e.target.value })}
              rows={2}
            />
          </label>
          <label className="field">
            <span>境界・守ってほしいこと</span>
            <textarea
              value={character.boundaries}
              onChange={(e) => setCharacter({ ...character, boundaries: e.target.value })}
              rows={2}
            />
          </label>
          <div className="field inline">
            <div className="inline-field">
              <span>リスナー名</span>
              <input
                value={character.listener}
                onChange={(e) => setCharacter({ ...character, listener: e.target.value })}
                placeholder="例: あなた"
              />
            </div>
            <div className="inline-field">
              <span>想定シーン</span>
              <input
                value={character.scenario}
                onChange={(e) => setCharacter({ ...character, scenario: e.target.value })}
                placeholder="例: 就寝前の囁き"
              />
            </div>
          </div>
          <div className="field">
            <span>台本長さ (段落数)</span>
            <input
              type="range"
              min={3}
              max={200}
              value={paragraphs}
              onChange={(e) => setParagraphs(Number(e.target.value))}
            />
            <div className="muted">{paragraphs} 段落くらい（最大200段落）</div>
          </div>
          <label className="field">
            <span>台本の目的・追加指示</span>
            <textarea
              value={scriptHint}
              onChange={(e) => setScriptHint(e.target.value)}
              rows={2}
              placeholder="例: 甘やかし系で寝かしつける"
            />
          </label>
          <div className="field">
            <span>生成されるプロンプト</span>
            <textarea value={promptPreview} readOnly rows={6} />
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>2. 台本生成 (Llama)</h2>
            <span className={`status ${llamaStatus}`}>{llamaStatus}</span>
          </div>
          <div className="field">
            <span>LLM温度</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={llamaTemp}
              onChange={(e) => setLlamaTemp(Number(e.target.value))}
            />
            <div className="muted">{llamaTemp.toFixed(2)}</div>
          </div>
          <div className="muted">生成トークン上限は段落数に応じて最大3500まで自動設定されます。</div>
          <button type="button" className="primary" onClick={runLlama} disabled={llamaStatus === 'loading'}>
            {llamaStatus === 'loading' ? '生成中...' : '台本を作成する'}
          </button>
          <div className="field">
            <span>台本</span>
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              rows={10}
              placeholder="生成された台本がここに表示されます"
            />
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>3. 参照音声アップロード (R2)</h2>
            <span className={`status ${uploadStatus}`}>{uploadStatus}</span>
          </div>
          <label className="field">
            <span>音声ファイル (WAV/MP3/M4A等)</span>
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
            />
            <p className="muted">{audioFile ? audioFile.name : 'ファイルが選択されていません'}</p>
            <p className="muted">プリセットは撤去しました。毎回、参照音声をアップロードしてください。</p>
          </label>
          <button type="button" onClick={handleUpload} disabled={uploadStatus === 'loading'}>
            {uploadStatus === 'loading' ? 'アップロード中...' : '参照音声をアップロード'}
          </button>
          {uploadMessage && <div className={uploadStatus === 'error' ? 'error' : 'muted'}>{uploadMessage}</div>}
          {uploadedKey && (
            <div className="muted">
              key: <code>{uploadedKey}</code>
              {uploadedPublicUrl && (
                <>
                  <br />
                  public:{' '}
                  <a href={uploadedPublicUrl} target="_blank" rel="noreferrer">
                    {uploadedPublicUrl}
                  </a>
                </>
              )}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>4. SoVITS 合成</h2>
            <span className={`status ${sovitsStatus}`}>{sovitsStatus}</span>
          </div>
          <div className="field">
            <span>オプション (固定値 / UI簡略)</span>
            <div className="muted">
              言語: ja / 速度: {sovitsSpeed.toFixed(1)} / temperature:1.0 / top_p:1.0 / sample_steps:8 / prosody: off /
              cut: punctuation
            </div>
          </div>
          <div className="field">
            <label htmlFor="speed">話速</label>
            <input
              id="speed"
              type="range"
              min="1.0"
              max="2.0"
              step="0.1"
              value={sovitsSpeed}
              onChange={(e) => setSovitsSpeed(parseFloat(e.target.value))}
            />
          </div>
          <button type="button" className="primary" onClick={handleSovits} disabled={sovitsStatus === 'loading'}>
            {sovitsStatus === 'loading' ? '合成中...' : 'ASMR音声を生成する'}
          </button>
          {sovitsMessage && <div className={sovitsStatus === 'error' ? 'error' : 'muted'}>{sovitsMessage}</div>}
          {taskId && (
            <div className="muted">
              ジョブID: <code>{taskId}</code>
            </div>
          )}
          {resultUrl && (
            <div className="audio-output">
              <audio controls src={resultObjectUrl ?? resultUrl} />
              <div className="muted">
                配布URL:{' '}
                <a href={resultUrl} target="_blank" rel="noreferrer">
                  {resultUrl}
                </a>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="card wide">
        <div className="card-header">
          <h2>ログ</h2>
        </div>
        <div className="log-window">
          {logs.length === 0 && <div className="muted">まだログはありません</div>}
          {logs.map((line, idx) => (
            <div key={idx} className="log-line">
              {line}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
