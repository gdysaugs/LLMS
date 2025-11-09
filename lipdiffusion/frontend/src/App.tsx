import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

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

  const selectedService = useMemo(
    () => SERVICES.find((item) => item.id === service),
    [service],
  )

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

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

        <button type="submit" disabled={status === 'loading'}>
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
