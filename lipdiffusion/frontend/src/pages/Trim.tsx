import { useState, useRef, useEffect, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { useNavigate } from 'react-router-dom'

export function Trim() {
  const navigate = useNavigate()

  const [loaded, setLoaded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [fileName, setFileName] = useState<string>('ファイルを選択してください')

  // WaveSurfer refs
  const waveformRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<any>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const basePxPerSecRef = useRef(30)

  // FFmpeg ref
  const ffmpegRef = useRef(new FFmpeg())

  // Load FFmpeg
  const load = useCallback(async () => {
    setIsLoading(true)
    const ffmpeg = ffmpegRef.current

    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

    if (ffmpeg.loaded) {
      setLoaded(true)
      setIsLoading(false)
      return
    }

    ffmpeg.on('log', ({ message }) => {
      console.log(message)
      setMessage(message)
    })

    try {
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
      })
      setLoaded(true)
      setMessage('ブラウザ処理の準備ができました。')
    } catch (error) {
      console.error('FFmpeg load failed:', error)
      setMessage('処理モジュールの読み込みに失敗しました: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    return () => {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy()
      }
    }
  }, [load])

  // Initialize WaveSurfer when audioUrl changes
  useEffect(() => {
    if (!audioUrl || !waveformRef.current) return

    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
    }

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#A78BFA',
      progressColor: '#8B5CF6',
      cursorColor: '#C4B5FD',
      barWidth: 2,
      barGap: 3,
      height: 128,
      normalize: true,
      minPxPerSec: 1,
    })

    const wsRegions = ws.registerPlugin(RegionsPlugin.create())
    regionsRef.current = wsRegions

    wsRegions.enableDragSelection({
      color: 'rgba(139, 92, 246, 0.3)',
    })

    const zoomToFit = () => {
      const duration = ws.getDuration()
      const containerWidth = waveformRef.current?.clientWidth || 800
      if (duration > 0) {
        // 画面幅に収める基準ズーム（常にフィット）
        const basePx = Math.max(containerWidth / duration, 1.2)
        basePxPerSecRef.current = basePx
        ws.zoom(basePx)
      }
    }

    ws.on('decode', () => {
      wsRegions.addRegion({
        start: 0,
        end: ws.getDuration() > 10 ? 10 : ws.getDuration(),
        color: 'rgba(139, 92, 246, 0.3)',
        drag: true,
        resize: true,
      })
      zoomToFit()
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => setIsPlaying(false))

    ws.load(audioUrl)
    wavesurferRef.current = ws

    const onResize = () => zoomToFit()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [audioUrl])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setAudioUrl(null)
    setMessage('')
    setFileName(file.name || '選択したファイル')

    if (file.type.startsWith('audio/')) {
      const url = URL.createObjectURL(file)
      setAudioUrl(url)
      return
    }

    if (file.type.startsWith('video/')) {
      // 動画は音声のみ抽出して波形トリムに使用
      await extractAudio(file)
      return
    }
  }

  const extractAudio = async (file: File) => {
    if (!loaded) {
      alert('FFmpeg is not loaded yet. Please wait or reload the page.')
      return
    }
    setIsProcessing(true)
    const ffmpeg = ffmpegRef.current

    try {
      const ext = file.name.substring(file.name.lastIndexOf('.'))
      const inputName = 'input' + (ext || '.mp4')

      await ffmpeg.writeFile(inputName, await fetchFile(file))

      setMessage('音声を抽出しています...')
      await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'libmp3lame', 'output.mp3'])

      const data = await ffmpeg.readFile('output.mp3')
      const blob = new Blob([data as any], { type: 'audio/mp3' })
      const url = URL.createObjectURL(blob)
      setAudioUrl(url)
      setMessage('音声を抽出しました。')
    } catch (err) {
      console.error(err)
      setMessage('音声抽出に失敗しました: ' + (err instanceof Error ? err.message : String(err)))
      alert('音声抽出に失敗しました')
    } finally {
      setIsProcessing(false)
    }
  }

  const trimAndSave = async () => {
    if (!loaded) {
      alert('FFmpeg is not loaded.')
      return
    }
    if (!wavesurferRef.current || !regionsRef.current) return

    const regions = regionsRef.current.getRegions()
    if (regions.length === 0) {
      setMessage('トリム範囲を選択してください。')
      alert('波形上でトリム範囲を選択してください。')
      return
    }

    const region = regions[regions.length - 1]
    const start = region.start
    const end = region.end
    const duration = end - start

    if (!audioUrl) return

    setIsProcessing(true)
    const ffmpeg = ffmpegRef.current

    try {
      const response = await fetch(audioUrl)
      const audioBlob = await response.blob()
      const inputName = `source_trim.mp3`
      await ffmpeg.writeFile(inputName, await fetchFile(audioBlob))

      setMessage(`トリム中: ${start.toFixed(2)}s 〜 ${end.toFixed(2)}s`)

      await ffmpeg.exec([
        '-i', inputName,
        '-ss', start.toString(),
        '-t', duration.toString(),
        '-af', 'highpass=f=80,lowpass=f=12000,afftdn=nf=-30,acompressor=threshold=-18dB:ratio=3:attack=15:release=120',
        '-ac', '1',
        '-ar', '44100',
        'trimmed_out.mp3'
      ])

      const data = await ffmpeg.readFile('trimmed_out.mp3')
      const trimmedBlob = new Blob([data as any], { type: 'audio/mp3' })

      const url = URL.createObjectURL(trimmedBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trimmed_${Date.now()}.mp3`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setMessage('トリム済み音声を保存しました。')

    } catch (e) {
      console.error(e)
      setMessage('トリムに失敗しました')
      alert('トリムに失敗しました')
    } finally {
      setIsProcessing(false)
    }
  }

  const useForGeneration = async () => {
    if (!loaded) {
      alert('FFmpeg is not loaded.')
      return
    }
    let blobToSend: Blob | null = null

    const regions = regionsRef.current?.getRegions() || []

    if (regions.length > 0) {
      const region = regions[regions.length - 1]
      const start = region.start
      const end = region.end
      const duration = end - start

      setIsProcessing(true)
      const ffmpeg = ffmpegRef.current

      try {
        if (!audioUrl) throw new Error("No audio loaded")
        const response = await fetch(audioUrl)
        const audioBlob = await response.blob()
        const inputName = `source_gen.mp3`
        await ffmpeg.writeFile(inputName, await fetchFile(audioBlob))

        await ffmpeg.exec([
          '-i', inputName,
          '-ss', start.toString(),
          '-t', duration.toString(),
          '-af', 'highpass=f=80,lowpass=f=12000,afftdn=nf=-30,acompressor=threshold=-18dB:ratio=3:attack=15:release=120',
          '-ac', '1',
          '-ar', '44100',
          'trimmed_gen.mp3'
        ])
        const data = await ffmpeg.readFile('trimmed_gen.mp3')
        blobToSend = new Blob([data as any], { type: 'audio/mp3' })
      } catch (e) {
        console.error(e)
        setMessage('生成用の音声準備に失敗しました')
        setIsProcessing(false)
        alert('生成用の音声準備に失敗しました')
        return
      } finally {
        setIsProcessing(false)
      }
    } else {
      if (!audioUrl) return
      const response = await fetch(audioUrl)
      const fullBlob = await response.blob()
      try {
        setIsProcessing(true)
        const inputName = `source_full.mp3`
        await ffmpegRef.current.writeFile(inputName, await fetchFile(fullBlob))
        await ffmpegRef.current.exec([
          '-i', inputName,
          '-af', 'highpass=f=80,lowpass=f=12000,afftdn=nf=-30,acompressor=threshold=-18dB:ratio=3:attack=15:release=120',
          '-ac', '1',
          '-ar', '44100',
          'denoised_full.mp3'
        ])
        const data = await ffmpegRef.current.readFile('denoised_full.mp3')
        blobToSend = new Blob([data as any], { type: 'audio/mp3' })
      } catch (e) {
        console.warn('ノイズ除去に失敗したため元の音声を使用します', e)
        blobToSend = fullBlob
      } finally {
        setIsProcessing(false)
      }
    }

    if (blobToSend) {
      const file = new File([blobToSend], "processed_audio.mp3", { type: "audio/mp3" })
      navigate('/generate', { state: { importedAudio: file } })
    }
  }

  const togglePlay = () => {
    if (wavesurferRef.current) {
      if (isPlaying) wavesurferRef.current.pause()
      else wavesurferRef.current.play()
    }
  }

  const playSelection = () => {
    const region = regionsRef.current?.getRegions()?.slice(-1)[0]
    if (region && wavesurferRef.current) {
      wavesurferRef.current.play(region.start, region.end)
    }
  }

  return (
    <div style={{ maxWidth: '920px', margin: '0 auto', padding: '40px 20px', color: '#fff' }}>
      <h1 style={{ fontSize: '32px', marginBottom: '8px', fontWeight: 'bold' }}>音声トリム & ノイズ除去</h1>
      <p style={{ color: '#b9c6e0', marginBottom: '24px' }}>
        動画をアップすると音声だけ抽出して波形表示します。音声ファイルもそのまま波形トリム可能です。
        <br />
        <span style={{ fontSize: '0.85em', color: loaded ? '#64ffda' : '#ef4444' }}>
          状態: {loaded ? '利用可能' : isLoading ? '読み込み中...' : '未読み込み（通信/ブラウザを確認）'}
        </span>
      </p>

      <div style={{
        background: 'rgba(255,255,255,0.05)',
        padding: '30px',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.1)',
        marginBottom: '20px'
      }}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{
            display: 'block',
            padding: '40px',
            border: '2px dashed rgba(255,255,255,0.2)',
            borderRadius: '12px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}>
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <div style={{ fontSize: '24px', marginBottom: '10px' }}>📂</div>
            <div style={{ fontWeight: '600', marginBottom: '5px' }}>
              動画または音声をアップロード
            </div>
            <div style={{ fontSize: '13px', color: '#8892b0' }}>
              MP4 / MOV / MP3 / WAV などに対応
            </div>
            <div style={{ marginTop: '8px', color: '#b9c6e0', fontSize: '12px' }}>{fileName}</div>
          </label>
        </div>

        {(isLoading || isProcessing) && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#64ffda' }}>
            {isLoading ? '処理モジュールを読み込み中...' : '処理中...'}
          </div>
        )}

        {message && <div style={{ marginBottom: '10px', fontSize: '12px', color: '#8892b0', fontFamily: 'monospace' }}>{message}</div>}

        <div style={{ display: 'grid', gap: '24px' }}>
          {/* Audio trim only */}
          <div style={{ opacity: audioUrl ? 1 : 0.5, pointerEvents: audioUrl ? 'auto' : 'none', transition: 'opacity 0.3s' }}>
            <div
          ref={waveformRef}
          style={{
            marginBottom: '12px',
            background: 'rgba(0,0,0,0.2)',
            borderRadius: '8px',
            overflowX: 'auto',
            overflowY: 'hidden',
            overscrollBehaviorX: 'contain'
          }}
        />

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '20px' }}>
              <button
                onClick={togglePlay}
                style={{
                  padding: '10px 24px',
                  borderRadius: '8px',
                  border: 'none',
                  background: '#64ffda',
                  color: '#0a192f',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                {isPlaying ? '⏸ 一時停止' : '▶ 再生'}
              </button>
              <button
                onClick={playSelection}
                disabled={!audioUrl}
                style={{
                  padding: '10px 20px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'transparent',
                  color: '#e5e7f5',
                  fontWeight: '600',
                  cursor: audioUrl ? 'pointer' : 'not-allowed'
                }}
              >
                🔁 選択区間を再生
              </button>
            </div>

            <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px' }}>
              <button
                onClick={trimAndSave}
                disabled={!loaded || isProcessing}
                style={{
                  flex: 1,
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(100, 255, 218, 0.3)',
                  background: 'transparent',
                  color: '#64ffda',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                ✂️ トリムして保存（ノイズ除去）
              </button>
              <button
                onClick={useForGeneration}
                disabled={!loaded || isProcessing}
                style={{
                  flex: 1,
                  padding: '12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #64ffda 0%, #48bfe3 100%)',
                  color: '#0a192f',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                🚀 トリムして生成画面へ
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ fontSize: '12px', color: '#8892b0', textAlign: 'center' }}>
        ブラウザ内で処理するため、素材は外部に送信されません。
      </div>
    </div>
  )
}
