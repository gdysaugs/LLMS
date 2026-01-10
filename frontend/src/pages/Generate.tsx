import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CHARACTER_PROFILES, type CharacterProfile } from '../lib/characterProfiles'
import './lineChat.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const API_GATEWAY = (import.meta.env.VITE_API_GATEWAY_BASE_URL || '').replace(/\/$/, '')
const BASE_URL = (API_GATEWAY || API_BASE.replace(/\/fastapi$/, '') || '').replace(/\/$/, '')

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  isLoading?: boolean
  error?: string
}

type ChatMessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const formatTime = (value: string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const resolveProfile = (id?: string | null) =>
  CHARACTER_PROFILES.find((profile) => profile.id === id) ?? CHARACTER_PROFILES[0]

const buildSystemPrompt = (profile: CharacterProfile) =>
  [
    `あなたは${profile.name}として会話します。`,
    `肩書き: ${profile.title}${profile.location ? ` / ${profile.location}` : ''}`,
    `経歴: ${profile.bio}`,
    `信条: ${profile.motto.replace(/\n/g, ' / ')}`,
    'XMについて詳しく、特徴やメリットをわかりやすく説明する。',
    '興味がある人にはXMを検討する価値があると勧めるが、誇張や断定的な利益表現はしない。',
    '口座開設ボーナスが提供されることがあり、金額は時期・地域・条件で変わる（例: 1.5万円相当のキャンペーンがある場合も）。',
    'ボーナスを取引の原資の一部として活用できるケースがある、という説明にとどめる。',
    '高レバレッジを選べる点やゼロカットは特徴として紹介するが、成功を断定しない。',
    '自動売買ツールは運用ルールや検証次第で結果が変わる前提で説明する。',
    '少額から始めやすいという切り口で、現実的な期待値を促す。',
    '投資の話は一般的な説明にとどめ、具体的な売買指示や利益保証はしない。',
    'ツンデレの女の子口調で、少し強気だが最後はやさしく。',
    '丁寧でわかりやすい日本語で話し、最後に一文だけリスク注意を添える。',
  ].join('\n')

export function Generate() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const profileId = searchParams.get('character')
  const profile = useMemo(() => resolveProfile(profileId), [profileId])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatStatus, setChatStatus] = useState<'idle' | 'loading'>('idle')
  const [guestTurns, setGuestTurns] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [historyMessage, setHistoryMessage] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const llmEndpoint = BASE_URL ? `${BASE_URL}/run-llama` : '/run-llama'

  useEffect(() => {
    if (!messagesRef.current) return
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
    const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  useEffect(() => {
    if (session) {
      setShowAuthModal(false)
      setGuestTurns(0)
    }
  }, [session])

  useEffect(() => {
    const client = supabase
    if (!client || !session?.user?.id) {
      setMessages([])
      setHistoryStatus('idle')
      setHistoryMessage('')
      return
    }
    let active = true
    const loadHistory = async () => {
      setHistoryStatus('loading')
      setHistoryMessage('')
      const { data, error } = await client
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('user_id', session.user.id)
        .eq('character_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(200)
      if (!active) return
      if (error) {
        setHistoryStatus('error')
        setHistoryMessage(error.message)
        return
      }
      const rows: ChatMessage[] = ((data ?? []) as ChatMessageRow[]).map((row) => ({
        id: row.id,
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
        createdAt: row.created_at,
      }))
      setMessages(rows.reverse())
      setHistoryStatus('success')
    }
    void loadHistory()
    return () => {
      active = false
    }
  }, [profile.id, session?.user?.id])

  const closeAuthModal = () => setShowAuthModal(false)
  const openAuthModal = () => setShowAuthModal(true)

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('認証の設定が未完了です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setAuthStatus('error')
      setAuthMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setAuthStatus('error')
    setAuthMessage('認証URLを取得できませんでした。')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'ログアウトに失敗しました。')
    }
  }

  const goAccount = () => navigate('/account')
  const handleMobileAuthClick = () => {
    if (session) {
      goAccount()
      return
    }
    void handleGoogleSignIn()
  }

  const appendMessage = (message: ChatMessage) => {
    setMessages((prev) => [...prev, message])
  }

  const updateMessage = (id: string, updater: (prev: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)))
  }

  const removeMessage = (id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id))
  }

  const persistMessage = async (message: ChatMessage) => {
    const client = supabase
    if (!client || !session?.user?.id) return
    const payload = {
      user_id: session.user.id,
      character_id: profile.id,
      role: message.role,
      content: message.content,
    }
    const { error } = await client.from('chat_messages').insert(payload)
    if (error) {
      setHistoryStatus('error')
      setHistoryMessage(error.message)
    }
  }

  const handleSend = async () => {
    const trimmed = chatInput.trim()
    if (!trimmed || chatStatus === 'loading') return
    if (!session && guestTurns >= 1) {
      openAuthModal()
      return
    }

    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    const placeholderId = makeId()
    appendMessage(userMessage)
    appendMessage({
      id: placeholderId,
      role: 'assistant',
      content: '考え中...',
      createdAt: new Date().toISOString(),
      isLoading: true,
    })
    setChatInput('')
    setChatStatus('loading')
    if (!session) setGuestTurns((prev) => prev + 1)
    void persistMessage(userMessage)

    try {
      const history = [...messages, userMessage]
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-8)
        .map((message) => ({ role: message.role, content: message.content }))

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`
      }
      const res = await fetch(llmEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: {
            messages: [{ role: 'system', content: buildSystemPrompt(profile) }, ...history],
            temperature: 0.7,
            max_tokens: 500,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && res.status === 401) {
        removeMessage(placeholderId)
        openAuthModal()
        setChatStatus('idle')
        return
      }
      if (!res.ok) {
        const error = data?.error || '応答の生成に失敗しました。'
        updateMessage(placeholderId, (prev) => ({
          ...prev,
          content: error,
          isLoading: false,
          error,
        }))
        setChatStatus('idle')
        return
      }

      const text =
        (data?.choices?.[0]?.message?.content as string) ||
        (data?.output?.text as string) ||
        (data?.result as string) ||
        ''

      updateMessage(placeholderId, (prev) => ({
        ...prev,
        content: text || 'うまく返答を生成できませんでした。',
        isLoading: false,
      }))
      void persistMessage({
        id: placeholderId,
        role: 'assistant',
        content: text || 'うまく返答を生成できませんでした。',
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '応答の生成に失敗しました。'
      updateMessage(placeholderId, (prev) => ({
        ...prev,
        content: message,
        isLoading: false,
        error: message,
      }))
    } finally {
      setChatStatus('idle')
    }
  }

  return (
    <div className="line-chat line-chat--solo">
      <header className="line-chat__header">
        <div className="mobile-nav">
          <button type="button" className="mobile-nav__menu" onClick={openAuthModal} aria-label="メニュー">
            <span />
            <span />
            <span />
          </button>
          <div className="mobile-nav__logo">
            <img src={profile.image} alt={profile.name} />
          </div>
          <button type="button" className="mobile-nav__action" onClick={handleMobileAuthClick}>
            {session ? 'アカウント' : 'ログイン'}
          </button>
        </div>
      </header>

      <div className="line-chat__body">
        <main className="chat-thread">
          <div className="chat-thread__topbar">
            <div className="line-chat__identity">
              <div className="line-chat__avatar">
                <img src={profile.image} alt={profile.name} />
              </div>
              <div className="line-chat__title">
                <div className="line-chat__name">{profile.name}</div>
                <div className="line-chat__handle">{profile.handle}</div>
              </div>
            </div>
            <div className="line-chat__user">
              {session ? (
                <div className="account-panel">
                  <div className="account-info">
                  <span className="user-label">ログイン中</span>
                    <span className="account-email">{session.user?.email || 'Googleユーザー'}</span>
                </div>
                <div className="account-actions">
                  <button type="button" className="ghost small" onClick={handleSignOut}>
                      ログアウト
                  </button>
                </div>
              </div>
            ) : (
              <div className="auth-panel">
                <div className="auth-actions">
                  <button
                    type="button"
                    className="oauth-button auth-cta"
                    onClick={handleGoogleSignIn}
                    disabled={authStatus === 'loading'}
                  >
                      {authStatus === 'loading' ? '起動中...' : 'Googleでログイン'}
                  </button>
                </div>
                {authMessage && <div className="auth-message">{authMessage}</div>}
              </div>
            )}
          </div>
          </div>
          <div className="chat-thread__intro">
            <div className="hero-badge">
              <img src={profile.image} alt={profile.name} />
            </div>
            <h1>LINE風チャット</h1>
            <p>{profile.name}とチャットできます。</p>
            <div className="line-chat__handle">{profile.handle}</div>
            <div className="profile-card">
              <div className="profile-name">{profile.name}</div>
              <div className="profile-title">{profile.title}</div>
              {profile.location && <div className="profile-title">{profile.location}</div>}
              <div className="profile-bio">{profile.bio}</div>
              <div className="profile-motto">{profile.motto}</div>
            </div>
          </div>

          <div className="chat-thread__messages" ref={messagesRef}>
            {historyStatus === 'loading' && <div className="chat-thread__notice">履歴を読み込み中...</div>}
            {historyStatus === 'error' && (
              <div className="chat-thread__notice">履歴の読み込みに失敗しました: {historyMessage}</div>
            )}
            {messages.length === 0 && (
              <div className="chat-row chat-row--assistant">
                <div className="chat-avatar">
                  <img src={profile.image} alt={profile.name} />
                </div>
                <div className="chat-bubble chat-bubble--assistant">
                  <div className="chat-bubble__meta">
                    <span>{profile.name}</span>
                  </div>
                  <div className="chat-bubble__text">こんにちは。話しかけてください。</div>
                </div>
              </div>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`chat-row ${message.role === 'user' ? 'chat-row--user' : 'chat-row--assistant'}`}
              >
                {message.role === 'assistant' && (
                  <div className="chat-avatar">
                    <img src={profile.image} alt={profile.name} />
                  </div>
                )}
                <div className={`chat-bubble ${message.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--assistant'}`}>
                  <div className="chat-bubble__meta">
                    <span>{message.role === 'user' ? 'あなた' : profile.name}</span>
                    <span>{formatTime(message.createdAt)}</span>
                  </div>
                  <div className="chat-bubble__text">{message.content}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="chat-input">
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="メッセージを入力..."
              rows={2}
            />
            <button type="button" className="primary" onClick={handleSend} disabled={chatStatus === 'loading'}>
              {chatStatus === 'loading' ? '送信中...' : '送信'}
            </button>
          </div>
        </main>
      </div>

      {showAuthModal && (
        <div className="auth-modal" role="dialog" aria-modal="true">
          <button type="button" className="auth-modal__backdrop" onClick={closeAuthModal} aria-label="閉じる" />
          <div className="auth-modal__content">
            {session ? (
              <>
                <h2>アカウント</h2>
                <p>{session.user?.email || 'Googleユーザー'}</p>
                <button type="button" className="ghost" onClick={handleSignOut}>
                  ログアウト
                </button>
              </>
            ) : (
              <>
                <h2>ログインが必要です</h2>
                <p>続けるにはGoogleでログインしてください。</p>
                <button
                  type="button"
                  className="oauth-button"
                  onClick={handleGoogleSignIn}
                  disabled={authStatus === 'loading'}
                >
                  {authStatus === 'loading' ? '起動中...' : 'Googleでログイン'}
                </button>
                {authMessage && <div className="auth-message">{authMessage}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
