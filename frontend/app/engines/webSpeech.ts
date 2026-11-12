import type { SpeakHandlers, SpeakOptions, TTSEngine } from './types'

export class WebSpeechEngine implements TTSEngine {
  readonly id = 'webspeech' as const
  voices: SpeechSynthesisVoice[] = []
  private current: SpeechSynthesisUtterance | null = null

  isSupported() { return typeof window !== 'undefined' && 'speechSynthesis' in window }

  loadVoices() { if (this.isSupported()) this.voices = window.speechSynthesis.getVoices() }

  private pickVoice(uri: string) {
    return this.voices.find(v => v.voiceURI === uri && uri)
      ?? this.voices.find(v => v.lang === 'zh-TW')
      ?? this.voices.find(v => v.lang.startsWith('zh'))
  }

  speak(text: string, opts: SpeakOptions, h: SpeakHandlers) {
    if (!this.isSupported()) return h.onError('Web Speech API not supported')
    this.cancel()
    const u = new SpeechSynthesisUtterance(text)
    this.current = u
    u.rate = opts.rate
    u.pitch = opts.pitch
    const voice = this.pickVoice(opts.voice)
    if (voice) { u.voice = voice; u.lang = voice.lang }
    u.onstart = () => { h.onStart?.(); h.onActivity?.() }
    u.onboundary = () => h.onActivity?.()
    u.onend = () => { if (this.current === u) { this.current = null; h.onEnd() } }
    u.onerror = (e) => {
      if (this.current !== u) return
      if (e.error === 'canceled' || e.error === 'interrupted') return
      this.current = null
      h.onError(e.error)
    }
    window.speechSynthesis.speak(u)
  }

  cancel() {
    this.current = null // detach so the cancel-triggered events are ignored
    if (this.isSupported()) window.speechSynthesis.cancel()
  }

  isActive() {
    return this.isSupported() && (window.speechSynthesis.speaking || window.speechSynthesis.pending)
  }
}
