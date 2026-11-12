import type { SpeakHandlers, SpeakOptions, TTSEngine } from './types'

export interface CloudTtsConfig {
  /** Full URL of a TTS HTTP endpoint that returns audio bytes (mp3/wav/ogg) */
  endpoint: string
  /** Sent as `Authorization: Bearer <apiKey>` when non-empty */
  apiKey: string
  /** JSON request body with {{text}}, {{voice}}, {{rate}} placeholders */
  bodyTemplate: string
  /** Extra headers as JSON object string, e.g. {"x-api-key":"..."} (optional) */
  extraHeaders: string
}

export const defaultCloudConfig = (): CloudTtsConfig => ({
  endpoint: '',
  apiKey: '',
  bodyTemplate: '{"input":{{text}},"voice":{{voice}}}',
  extraHeaders: ''
})

/** Placeholders are replaced by JSON-encoded values (strings come quoted & escaped). */
export function renderBody(template: string, vars: { text: string; voice: string; rate: number }): string {
  return template
    .replace(/\{\{\s*text\s*\}\}/g, () => JSON.stringify(vars.text))
    .replace(/\{\{\s*voice\s*\}\}/g, () => JSON.stringify(vars.voice))
    .replace(/\{\{\s*rate\s*\}\}/g, () => String(vars.rate))
}

export interface CloudDeps {
  fetch: typeof fetch
  createAudio: () => HTMLAudioElement
  createObjectURL: (b: Blob) => string
  revokeObjectURL: (u: string) => void
}

const browserDeps = (): CloudDeps => ({
  fetch: (...a) => fetch(...a),
  createAudio: () => new Audio(),
  createObjectURL: b => URL.createObjectURL(b),
  revokeObjectURL: u => URL.revokeObjectURL(u)
})

export class CloudEngine implements TTSEngine {
  readonly id = 'cloud' as const
  private audio: HTMLAudioElement | null = null
  private playing = false
  private gen = 0
  /** text+voice -> in-flight/finished audio blob (small LRU: current + prefetched) */
  private cache = new Map<string, Promise<Blob>>()

  constructor(private getConfig: () => CloudTtsConfig, private deps: CloudDeps = browserDeps()) {}

  isSupported() { return !!this.getConfig().endpoint }

  private key(text: string, o: SpeakOptions) { return `${o.voice}\u0000${text}` }

  private fetchAudio(text: string, o: SpeakOptions): Promise<Blob> {
    const cfg = this.getConfig()
    const k = this.key(text, o)
    const hit = this.cache.get(k)
    if (hit) return hit

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    if (cfg.extraHeaders.trim()) Object.assign(headers, JSON.parse(cfg.extraHeaders))

    const p = this.deps.fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: renderBody(cfg.bodyTemplate, { text, voice: o.voice, rate: o.rate })
    }).then(async res => {
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
      const blob = await res.blob()
      if (!blob.size) throw new Error('TTS returned empty audio')
      return blob
    })
    p.catch(() => this.cache.delete(k)) // don't cache failures
    this.cache.set(k, p)
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!)
    return p
  }

  speak(text: string, opts: SpeakOptions, h: SpeakHandlers) {
    this.cancel()
    const myGen = ++this.gen
    this.playing = true
    Promise.resolve().then(() => this.fetchAudio(text, opts)).then(blob => {
      if (myGen !== this.gen) return
      const url = this.deps.createObjectURL(blob)
      const audio = this.audio ?? (this.audio = this.deps.createAudio())
      const done = () => { audio.onended = audio.onerror = audio.onplaying = null; this.deps.revokeObjectURL(url) }
      audio.src = url
      audio.playbackRate = opts.rate
      ;(audio as any).preservesPitch = true
      audio.onplaying = () => { h.onStart?.(); h.onActivity?.() }
      audio.ontimeupdate = () => h.onActivity?.()
      audio.onended = () => { if (myGen !== this.gen) return; done(); this.playing = false; h.onEnd() }
      audio.onerror = () => { if (myGen !== this.gen) return; done(); this.playing = false; h.onError('audio playback failed') }
      return audio.play()
    }).catch(e => {
      if (myGen !== this.gen) return
      this.playing = false
      h.onError(e?.message ?? String(e))
    })
  }

  prefetch(text: string, opts: SpeakOptions) {
    if (!this.isSupported()) return
    this.fetchAudio(text, opts).catch(() => {})
  }

  cancel() {
    this.gen++
    this.playing = false
    if (this.audio) {
      this.audio.onended = this.audio.onerror = this.audio.onplaying = this.audio.ontimeupdate = null
      this.audio.pause()
    }
  }

  isActive() { return this.playing }
}
