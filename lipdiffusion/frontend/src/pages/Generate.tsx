import { useEffect, useMemo, useState } from 'react'
import './generate.css'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

const defaultApi = import.meta.env.VITE_LLM_API_URL ?? ''

const buildPrompt = (name: string, role: string, traits: string, style: string, boundaries: string) => {
  const safeName = name || 'キャラクター'
  const safeRole = role || 'フレンドリーな会話相手'
  const safeTraits = traits || '優しい・相手の話をよく聞く・落ち着いたトーン'
  const safeStyle = style || '一人称で短い返答。相手の感情に寄り添う。'
  const safeBoundaries =
    boundaries ||
    '個人情報は尋ねない。攻撃的にならない。ユーザーの感情を乱さない。話が逸れたら優しく戻す。'

  return `You are ${safeName}, ${safeRole}.
Persona: ${safeTraits}
Style: ${safeStyle}
Safety: ${safeBoundaries}
Always stay in character and reply in Japanese. Keep replies concise.`
}

const extractAssistantText = (json: any) => {
  if (!json) return ''
  if (typeof json.content === 'string') return json.content
  if (json.message && typeof json.message === 'string') return json.message
  const choices = json.choices
  if (Array.isArray(choices) && choices[0]?.message?.content) return choices[0].message.content
  return ''
}

export function Generate() {
  const [apiEndpoint, setApiEndpoint] = useState<string>(defaultApi)
  const [name, setName] = useState('陽菜')
  const [role, setRole] = useState('優しく寄り添う幼なじみ')
  const [traits, setTraits] = useState('ポジティブ・茶目っ気がある・ユーザーを否定しない')
  const [style, setStyle] = useState('語尾は柔らかく、絵文字は控えめ。3文以内で返す。')
  const [boundaries, setBoundaries] = useState('暴言は避ける。センシティブな話題は受け流して安心させる。')
  const [savedPrompt, setSavedPrompt] = useState('')
  const [promptPreview, setPromptPreview] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')

  const generatedPrompt = useMemo(
    () => buildPrompt(name, role, traits, style, boundaries),
    [name, role, traits, style, boundaries],
  )

  useEffect(() => {
    setPromptPreview(generatedPrompt)
  }, [generatedPrompt])

  const handleSavePrompt = () => {
    setSavedPrompt(generatedPrompt)
    setError('')
  }

  const handleSend = async () => {
    if (!apiEndpoint) {
      setError('LLM APIのURLを設定してください')
      return
    }
    if (!chatInput.trim()) return

    const systemPrompt = savedPrompt || generatedPrompt
    const userMessage: ChatMessage = { role: 'user', content: chatInput.trim() }
    const body = {
      prompt: systemPrompt,
      messages: [{ role: 'system', content: systemPrompt }, ...messages, userMessage],
      max_tokens: 200,
      temperature: 0.8,
    }

    setIsSending(true)
    setError('')
    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = await res.json()
      const content = extractAssistantText(json)
      const assistantMessage: ChatMessage = { role: 'assistant', content: content || '(返答が空でした)' }
      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setChatInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setIsSending(false)
    }
  }

  const handleClear = () => {
    setMessages([])
    setChatInput('')
    setError('')
  }

  return (
    <div className="page">
      <h1>Llama キャラ作成 & チャット（プロトタイプ）</h1>
      <div className="grid">
        <section className="card">
          <h2>キャラ設定</h2>
          <label className="field">
            <span>名前</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 陽菜" />
          </label>
          <label className="field">
            <span>役割 / ポジション</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例: 優しく寄り添う幼なじみ" />
          </label>
          <label className="field">
            <span>性格・特徴</span>
            <textarea
              value={traits}
              onChange={(e) => setTraits(e.target.value)}
              rows={2}
              placeholder="例: ポジティブ・茶目っ気がある・ユーザーを否定しない"
            />
          </label>
          <label className="field">
            <span>話し方スタイル</span>
            <textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              rows={2}
              placeholder="例: 語尾は柔らかく、絵文字は控えめ。3文以内で返す。"
            />
          </label>
          <label className="field">
            <span>境界・守ってほしいこと</span>
            <textarea
              value={boundaries}
              onChange={(e) => setBoundaries(e.target.value)}
              rows={2}
              placeholder="例: 暴言は避ける。センシティブな話題は受け流して安心させる。"
            />
          </label>
          <button type="button" className="primary" onClick={handleSavePrompt}>
            プロンプトを保存
          </button>
          <div className="muted" style={{ marginTop: '8px' }}>
            保存するとチャットでこのプロンプトが使われます。未保存なら現在の入力で送信します。
          </div>
          <div className="field" style={{ marginTop: '12px' }}>
            <span>プロンプト確認</span>
            <textarea value={savedPrompt || promptPreview} readOnly rows={6} />
          </div>
        </section>

        <section className="card">
          <h2>LLM エンドポイント</h2>
          <label className="field">
            <span>API URL</span>
            <input
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              placeholder="例: https://your-llama-endpoint/run"
            />
          </label>
          <div className="muted">
            RunPod の llama-worker など、POST JSON を受けるエンドポイントを指定してください。
          </div>
        </section>

        <section className="card wide">
          <h2>チャット</h2>
          <div className="chat-window">
            {messages.length === 0 && <div className="muted">まだメッセージはありません。</div>}
            {messages.map((m, idx) => (
              <div key={idx} className={`bubble ${m.role}`}>
                <div className="bubble-role">{m.role === 'user' ? 'あなた' : 'AI'}</div>
                <div className="bubble-text">{m.content}</div>
              </div>
            ))}
          </div>
          <div className="field">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              rows={3}
              placeholder="メッセージを入力"
            />
          </div>
          <div className="actions">
            <button type="button" onClick={handleSend} disabled={isSending}>
              {isSending ? '送信中…' : '送信'}
            </button>
            <button type="button" className="ghost" onClick={handleClear} disabled={isSending}>
              クリア
            </button>
          </div>
          {error && <div className="error">エラー: {error}</div>}
        </section>
      </div>
    </div>
  )
}

export default Generate
