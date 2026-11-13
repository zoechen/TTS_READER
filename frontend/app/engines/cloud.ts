import type { SpeakHandlers, SpeakOptions, TTSEngine } from './types'

export interface CloudTtsConfig {
  /** TTS HTTP 端點的完整 URL，回傳音訊位元組（mp3/wav/ogg） */
  endpoint: string
  /** 非空時以 `Authorization: Bearer <apiKey>` 送出 */
  apiKey: string
  /** JSON 請求 body 範本，含 {{text}}、{{voice}}、{{rate}} 佔位符 */
  bodyTemplate: string
  /** 額外標頭，JSON 物件字串，例如 {"x-api-key":"..."}（選填） */
  extraHeaders: string
}

export const defaultCloudConfig = (): CloudTtsConfig => ({
  endpoint: '',
  apiKey: '',
  bodyTemplate: '{"input":{{text}},"voice":{{voice}}}',
  extraHeaders: ''
})

/** 佔位符會被代換成 JSON 編碼後的值（字串會加引號並跳脫）。 */
export function renderBody(template: string, vars: { text: string; voice: string; rate: number; pitch?: number }): string {
  return template
    .replace(/\{\{\s*text\s*\}\}/g, () => JSON.stringify(vars.text))
    .replace(/\{\{\s*voice\s*\}\}/g, () => JSON.stringify(vars.voice))
    .replace(/\{\{\s*rate\s*\}\}/g, () => String(vars.rate))
    .replace(/\{\{\s*pitch\s*\}\}/g, () => String(vars.pitch ?? 0))
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

/**
 * 【前後端對接點 ③】雲端 TTS 引擎（對應後端 POST /api/v1/tts）
 *
 * 單句朗讀流程：
 *  1. useSpeechReader 呼叫 speak(文字, {voice, rate, pitchPct})
 *  2. fetchAudio：依 bodyTemplate 組出 JSON（代理模式為
 *     {"text":..,"voice":..,"rate":..,"pitch":..}）POST 給後端
 *  3. 後端用 edge-tts 合成，回傳 audio/mpeg 二進位
 *  4. 前端 res.blob() → URL.createObjectURL → <audio> 播放；播完觸發 onEnd 接下一句
 *
 * 延遲遮蔽：播放當句時 prefetch 下一句，結果存在 cache（Promise<Blob>），下一句直接命中。
 * 快取鍵 = 語音+語速+音調+文字，參數不同就不會誤用舊音訊；失敗不快取。
 * 取消機制：gen 世代號，每次 cancel/speak 遞增，過期的非同步回呼一律丟棄（避免重複朗讀）。
 */
export class CloudEngine implements TTSEngine {
  readonly id = 'cloud' as const
  private audio: HTMLAudioElement | null = null
  private playing = false
  private gen = 0
  /** 文字+語音 → 下載中/已完成的音訊 blob（小型 LRU：目前這句 + 預取的句子） */
  private cache = new Map<string, Promise<Blob>>()

  constructor(private getConfig: () => CloudTtsConfig, private deps: CloudDeps = browserDeps()) {}

  isSupported() { return !!this.getConfig().endpoint }

  /** 為 true 時由伺服器在合成時套用語速/音調（Edge provider），playbackRate 維持 1。 */
  serverProsody = false

  private key(text: string, o: SpeakOptions) { return `${o.voice}\u0000${o.rate}\u0000${o.pitchPct ?? 0}\u0000${text}` }

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
      body: renderBody(cfg.bodyTemplate, { text, voice: o.voice, rate: o.rate, pitch: o.pitchPct ?? 0 })
    }).then(async res => {
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
      const blob = await res.blob()
      if (!blob.size) throw new Error('TTS returned empty audio')
      return blob
    })
    p.catch(() => this.cache.delete(k)) // 失敗不快取
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
      audio.playbackRate = this.serverProsody ? 1 : opts.rate
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
