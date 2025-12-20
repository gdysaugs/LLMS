import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import './generate.css'

type CharacterPreset = {
  id: string
  label: string
  image: string
  preset: {
    name: string
    role: string
    traits: string
    style: string
    boundaries: string
    listener: string
    scenario: string
  }
}

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

const defaultModelPath = '/opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf'
const defaultCharacterImage = '/media/character.png'

export function Generate() {
  const API_GATEWAY_BASE = null

  const makeBases = (base: string | null) => {
    const list: string[] = []
    if (base) list.push(base.replace(/\/$/, ''))
    const root = base ? base.replace(/\/fastapi$/, '').replace(/\/$/, '') : null
    if (root && !list.includes(root)) list.push(root)
    return list
  }
  const API_BASE = useMemo(() => {
    if (API_GATEWAY_BASE) return `${API_GATEWAY_BASE}/fastapi`
    return import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '/fastapi'
  }, [API_GATEWAY_BASE])
  const API_KEY = import.meta.env.VITE_API_KEY

  const characterPresets: CharacterPreset[] = [
    {
      id: 'hina',
      label: '陽菜 (優しくてシャイな後輩)',
      image: '/media/hina.png',
      preset: {
        name: '陽菜',
        role: '優しくてシャイな学校の後輩',
        traits: '恥ずかしがり屋で素直。甘えたがりだが気遣いができる。',
        style: '語尾は柔らかく、ゆっくり優しく囁く。',
        boundaries: 'セリフのみで一人語り。相手のセリフは書かない。',
        listener: 'あなた',
        scenario: '放課後の教室で二人きりで過ごす',
      },
    },
    {
      id: 'rion',
      label: 'リオン (強気な同級生)',
      image: '/media/rion.png',
      preset: {
        name: 'リオン',
        role: '強気で口調が荒い女同級生',
        traits: '口調が少し荒く、男勝り。嫌がりながらエッチなこともする',
        style: 'ズバッと言い切るテンポの良い話し方。あんっ！んぁっ！ああんっ！などの喘ぎ声を出す',
        boundaries: 'セリフのみで一人語り。相手のセリフは書かない。',
        listener: 'あなた',
        scenario: 'エッチ中',
      },
    },
  ]

  const scenePresets = [
    { id: 'school', label: '学校', scenario: '放課後の教室でエッチ' },
    { id: 'home', label: '自宅', scenario: '自宅でエッチ' },
  ]

  const actionPresets = [
    { id: 'hug', label: 'レイプ', hint: 'リスナーに無理やり犯される' },
    { id: 'cry', label: 'フェラ', hint: 'リスナーをフェラする　じゅぽっ、じゅるるっじゅぽぽっ、ちゅぱっなどの擬音出す' },
    { id: 'hand', label: '中だし', hint: 'リスナーに中だしされる' },
  ]

  const [selectedCharacter, setSelectedCharacter] = useState(characterPresets[0].id)
  const [listenerName, setListenerName] = useState('あなた')
  const [character, setCharacter] = useState({ ...characterPresets[0].preset, listener: 'あなた' })
  const [selectedScene, setSelectedScene] = useState(scenePresets[0].id)
  const [selectedActions, setSelectedActions] = useState<string[]>([])
  const paragraphCount = 6
  const [scriptText, setScriptText] = useState('')
  const [llamaStatus, setLlamaStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [llamaTemp, setLlamaTemp] = useState(0.85)

  const fixedAudio = useMemo(() => {
    if (selectedCharacter === 'rion') {
      return {
        key: 'sampleaudio/moushiwakegozaimasenn_02.wav',
        url: null as string | null,
        label: 'sampleaudio/moushiwakegozaimasenn_02.wav',
      }
    }
    return {
      key: 'sampleaudio/hello2.mp3',
      url: null as string | null,
      label: 'sampleaudio/hello2.mp3',
    }
  }, [selectedCharacter])

  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('success')
  const [uploadMessage, setUploadMessage] = useState(`固定参照音声を利用: ${fixedAudio.label}`)
  const [uploadedKey, setUploadedKey] = useState<string | null>(fixedAudio.key)
  const [uploadedPublicUrl, setUploadedPublicUrl] = useState<string | null>(fixedAudio.url)

  const [sovitsStatus, setSovitsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [sovitsMessage, setSovitsMessage] = useState('')
  const [sovitsSpeed] = useState<number>(1.0)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultObjectUrl, setResultObjectUrl] = useState<string | null>(null)

  const [logs, setLogs] = useState<string[]>([])
  const [searchParams] = useSearchParams()

  const selectedPreset = characterPresets.find((c) => c.id === selectedCharacter)
  const characterImage = selectedPreset?.image ?? defaultCharacterImage
  const characterRoleText = character.role || selectedPreset?.preset.role || ''
  const characterTraitsText = character.traits || selectedPreset?.preset.traits || ''

  const appendLog = (message: string) =>
    setLogs((prev) => [...prev, `[${formatLogTime()}] ${message}`].slice(-200))

  useEffect(() => {
    return () => {
      if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl)
    }
  }, [resultObjectUrl])

  useEffect(() => {
    // キャラ変更時に参照音声を同期
    setUploadStatus('success')
    setUploadMessage(`固定参照音声を利用: ${fixedAudio.label}`)
    setUploadedKey(fixedAudio.key)
    setUploadedPublicUrl(fixedAudio.url)
  }, [fixedAudio])

  const ensureApiKey = () => {
    if (!API_KEY) throw new Error('VITE_API_KEY が未設定です (X-Api-Key/Bearer 用)')
    return API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
  }

  const sanitizeScript = (text: string) => text.trim()

  const sceneText = useMemo(
    () => scenePresets.find((s) => s.id === selectedScene)?.scenario ?? character.scenario,
    [selectedScene, scenePresets, character.scenario],
  )

  const actionText = useMemo(() => {
    const picked = selectedActions
      .map((id) => actionPresets.find((a) => a.id === id)?.hint ?? '')
      .filter(Boolean)
    return picked.join(' / ')
  }, [selectedActions, actionPresets])

  const buildUserInput = () => {
    const lines = [
      `あなたは${character.name}として振る舞い、${listenerName}に直接語りかける一人語りのセリフだけを生成してください。`,
      `役割: ${character.role}`,
      `性格: ${character.traits}`,
      `話し方: ${character.style}`,
      `守ること: ${character.boundaries}`,
      `シーン: ${sceneText}`,
      `行動ヒント: ${actionText || '選択に合わせて臨機応変に'}`,
      `必ずリスナーを「${listenerName}」と名前で呼びかける。相手のセリフやラベル、記号、括弧は書かない。説明文やナレーションも書かない。セリフのみで500文字以上。`,
    ]
    return lines.join('\n')
  }

  const applyCharacter = (id: string) => {
    const found = characterPresets.find((c) => c.id === id)
    if (!found) return
    setSelectedCharacter(id)
    setCharacter({ ...found.preset, listener: listenerName })
  }

  useEffect(() => {
    const fromQuery = searchParams.get('character')
    if (fromQuery && fromQuery !== selectedCharacter && characterPresets.some((c) => c.id === fromQuery)) {
      applyCharacter(fromQuery)
    }
  }, [searchParams, selectedCharacter])

  const applyScene = (id: string) => {
    const found = scenePresets.find((s) => s.id === id)
    if (found) {
      setSelectedScene(id)
      setCharacter((prev) => ({ ...prev, scenario: found.scenario }))
    }
  }

  const toggleAction = (id: string) => {
    setSelectedActions((prev) => {
      const exists = prev.includes(id)
      if (exists) return prev.filter((x) => x !== id)
      if (prev.length >= 3) return prev
      return [...prev, id]
    })
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

  const extractLlamaText = (json: any, prompt: string) => {
    return (
      (json?.output?.text as string) ||
      (json?.output?.result as string) ||
      (json?.result as string) ||
      (json?.choices?.[0]?.message?.content as string) ||
      (json?.text as string) ||
      prompt
    )
  }

  const runLlama = async () => {
    setLlamaStatus('loading')
    setResultUrl(null)
    setTaskId(null)
    appendLog('LLM: 生成を開始します')

    const userInput = buildUserInput()
    const prompt = ''
    const maxTokens = Math.min(3500, Math.max(800, paragraphCount * 320))
    const llamaBases = makeBases(API_GATEWAY_BASE ?? API_BASE)
    const body = {
      input: {
        prompt,
        max_tokens: maxTokens,
        user_input: userInput,
        temperature: llamaTemp,
        model: defaultModelPath,
        model_path: defaultModelPath,
      },
    }

    try {
      let lastErr: unknown = null
      let res: Response | null = null
      for (const base of llamaBases) {
        const url = `${base.replace(/\/$/, '')}/run-llama`
        try {
          res = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: ensureApiKey() },
            body: JSON.stringify(body),
          })
          break
        } catch (err) {
          res = null
          lastErr = err
        }
      }
      if (!res) throw lastErr ?? new Error('LLM endpoint unreachable')
      const json = await res.json()
      const text = extractLlamaText(json, prompt)

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
        const statusUrls = llamaBases.map((b) => `${b.replace(/\/$/, '')}/run-llama/status/${jobId}`)
        for (let i = 0; i < 120; i++) {
          let sj: any = null
          for (const su of statusUrls) {
            try {
              const st = await fetch(su, { headers: { Authorization: ensureApiKey() } })
              sj = await st.json()
              break
            } catch {
              continue
            }
          }
          if (!sj) throw new Error('LLM ステータス取得に失敗しました')
          const content = extractLlamaText(sj, prompt)
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

  const ensureUploaded = async () => {
    const key = uploadedKey ?? fixedAudio.key
    const public_url = uploadedPublicUrl ?? fixedAudio.url
    setUploadedKey(key)
    setUploadedPublicUrl(public_url ?? null)
    return { key, public_url }
  }

  const handleUpload = async () => {
    setUploadStatus('success')
    setUploadMessage(`固定参照音声を利用: ${fixedAudio.label}`)
    appendLog('R2: 固定参照音声を使用（アップロード不要）')
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
    const statusUrls = makeBases(API_GATEWAY_BASE ?? API_BASE).map(
      (b) => `${b.replace(/\/$/, '')}/run-sovits/status/${id}`,
    )
    for (let i = 0; i < 240; i++) {
      let json: TaskRecord | null = null
      for (const su of statusUrls) {
        try {
          const res = await fetchWithRetry(su, { headers: { Authorization: ensureApiKey() } }, 2, 1200)
          json = (await res.json()) as TaskRecord
          break
        } catch {
          continue
        }
      }
      if (!json) throw new Error('ステータス取得に失敗しました')
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

      let res: Response | null = null
      for (const base of makeBases(API_GATEWAY_BASE ?? API_BASE)) {
        const url = `${base.replace(/\/$/, '')}/run-sovits`
        try {
          res = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: ensureApiKey(),
            },
            body: JSON.stringify(payload),
          })
          break
        } catch {
          res = null
          continue
        }
      }
      if (!res) throw new Error('SoVITS エンドポイントに到達できませんでした')

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
          <span className="chip">R2 固定参照音声</span>
        </div>
      </header>

      <div className="grid">
        <section className="card">
          <div className="card-header">
            <h2>1. キャラクター設定</h2>
            <span className="muted">システムプロンプトに反映</span>
          </div>
          <div className="character-preview">
            <div className="character-portrait">
              <img src={characterImage} alt={`${(character.name || selectedPreset?.preset.name || 'キャラクター')}のプレビュー`} />
            </div>
            <div className="character-meta">
              <p className="muted">キャラプレビュー</p>
              <h3>{character.name || selectedPreset?.preset.name || 'キャラクター'}</h3>
              {characterRoleText && <p className="muted small">{characterRoleText}</p>}
              {characterTraitsText && <p className="muted small">{characterTraitsText}</p>}
            </div>
          </div>
          <div className="field inline">
            <div className="inline-field">
              <span>キャラプリセット</span>
              <select value={selectedCharacter} onChange={(e) => applyCharacter(e.target.value)}>
                {characterPresets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="inline-field">
              <span>シチュエーションプリセット</span>
              <select value={selectedScene} onChange={(e) => applyScene(e.target.value)}>
                {scenePresets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <span>行動プリセット (最大3つまで)</span>
            <div className="chip-row">
              {actionPresets.map((a) => (
                <label key={a.id} className="chip selectable">
                  <input
                    type="checkbox"
                    checked={selectedActions.includes(a.id)}
                    onChange={() => toggleAction(a.id)}
                  />
                  <span>{a.label}</span>
                </label>
              ))}
            </div>
            <div className="muted">{selectedActions.length}/3 選択中</div>
          </div>
          <label className="field">
            <span>リスナー名（呼びかける名前）</span>
            <input
              value={listenerName}
              onChange={(e) => {
                setListenerName(e.target.value)
                setCharacter((prev) => ({ ...prev, listener: e.target.value }))
              }}
              placeholder="例: あなた / たくみ"
            />
          </label>
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
            <h2>3. 参照音声 (R2 固定)</h2>
            <span className={`status ${uploadStatus}`}>{uploadStatus}</span>
          </div>
          <label className="field">
            <span>音声ファイル (任意)</span>
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
            />
            <p className="muted">{audioFile ? audioFile.name : '固定参照音声を使うため未選択でOK'}</p>
            <p className="muted">常に {fixedAudio.label} を使用します。アップロードは不要です。</p>
          </label>
          <button type="button" onClick={handleUpload} disabled={uploadStatus === 'loading'}>
            {uploadStatus === 'loading' ? '準備中...' : '固定参照音声を使う'}
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
              言語: ja / 速度: {sovitsSpeed.toFixed(1)} (固定) / temperature:1.0 / top_p:1.0 / sample_steps:8 / prosody: off /
              cut: punctuation
            </div>
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
