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

  // WaveSurfer refs
  const waveformRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<any>(null)
  const [isPlaying, setIsPlaying] = useState(false)

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
      setMessage('Ready to process (CDN).')
    } catch (error) {
      console.error('FFmpeg load failed:', error)
      setMessage('Error: Failed to load system. ' + (error instanceof Error ? error.message : String(error)))
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
      minPxPerSec: 50,
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
        // 画面幅にフィットするように px/sec を計算（長尺でも横スクロール不要に）
        const px = Math.min(Math.max(containerWidth / duration, 1), 80)
        ws.zoom(px)
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

    if (file.type.startsWith('audio/')) {
      const url = URL.createObjectURL(file)
      setAudioUrl(url)
      return
    }

    if (file.type.startsWith('video/')) {
      await extractAudio(file)
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

      setMessage('Extracting audio...')
      await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'libmp3lame', 'output.mp3'])

      const data = await ffmpeg.readFile('output.mp3')
      const blob = new Blob([data as any], { type: 'audio/mp3' })
      const url = URL.createObjectURL(blob)
      setAudioUrl(url)
      setMessage('Audio extracted!')
    } catch (err) {
      console.error(err)
      setMessage('Failed to extract audio: ' + (err instanceof Error ? err.message : String(err)))
      alert('Failed to extract audio')
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
      setMessage('Please select a region to trim')
      alert('Please select a region to trim on the waveform.')
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

      setMessage(`Trimming from ${start.toFixed(2)}s to ${end.toFixed(2)}s...`)

      await ffmpeg.exec([
        '-i', inputName,
        '-ss', start.toString(),
        '-t', duration.toString(),
        '-af', 'afftdn',
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

      setMessage('Trimmed audio downloaded!')

    } catch (e) {
      console.error(e)
      setMessage("Failed to trim audio")
      alert('Failed to trim audio')
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
          '-af', 'afftdn',
          '-ac', '1',
          '-ar', '44100',
          'trimmed_gen.mp3'
        ])
        const data = await ffmpeg.readFile('trimmed_gen.mp3')
        blobToSend = new Blob([data as any], { type: 'audio/mp3' })
      } catch (e) {
        console.error(e)
        setMessage("Failed to prepare audio for generation")
        setIsProcessing(false)
        alert('Failed to prepare audio')
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
          '-af', 'afftdn',
          '-ac', '1',
          '-ar', '44100',
          'denoised_full.mp3'
        ])
        const data = await ffmpegRef.current.readFile('denoised_full.mp3')
        blobToSend = new Blob([data as any], { type: 'audio/mp3' })
      } catch (e) {
        console.warn('Denoise failed, using original full audio', e)
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

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 20px', color: '#fff' }}>
      <h1 style={{ fontSize: '32px', marginBottom: '10px', fontWeight: 'bold' }}>
        Audio Tools
      </h1>
      <p style={{ color: '#8892b0', marginBottom: '30px' }}>
        Trim audio or extract audio from video files entirely in your browser. <br />
        <span style={{ fontSize: '0.8em', color: loaded ? '#64ffda' : '#ef4444' }}>
          System Status: {loaded ? 'Ready' : isLoading ? 'Loading...' : 'Not Loaded (Check connection/browser)'}
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
              Click to Upload Video or Audio
            </div>
            <div style={{ fontSize: '13px', color: '#8892b0' }}>
              Supports MP4, MOV, MP3, WAV
            </div>
          </label>
        </div>

        {(isLoading || isProcessing) && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#64ffda' }}>
            {isLoading ? 'Loading FFmpeg...' : 'Processing...'}
          </div>
        )}

        {message && <div style={{ marginBottom: '10px', fontSize: '12px', color: '#8892b0', fontFamily: 'monospace' }}>{message}</div>}

        <div style={{ opacity: audioUrl ? 1 : 0.5, pointerEvents: audioUrl ? 'auto' : 'none', transition: 'opacity 0.3s' }}>
          <div
            ref={waveformRef}
            style={{
              marginBottom: '20px',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
              overflow: 'hidden'
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
              {isPlaying ? '⏸ Pause' : '▶ Play'}
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
              ✂️ Trim & Save
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
              🚀 Use for Generation
            </button>
          </div>
        </div>
      </div>

      <div style={{ fontSize: '12px', color: '#8892b0', textAlign: 'center' }}>
        Powered by ffmpeg.wasm & wavesurfer.js - All processing happens in your browser.
      </div>
    </div>
  )
}
