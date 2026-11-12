export interface SpeakOptions {
  rate: number
  pitch: number
  /** Engine-specific voice identifier (voiceURI for Web Speech, voice name/id for cloud) */
  voice: string
}

export interface SpeakHandlers {
  onStart?: () => void
  /** Called on progress events so the keep-alive heartbeat knows the engine is alive */
  onActivity?: () => void
  onEnd: () => void
  /** Real failures only; cancellation must NOT call onError */
  onError: (message: string) => void
}

/** Strategy interface: one utterance at a time. */
export interface TTSEngine {
  readonly id: 'webspeech' | 'cloud'
  isSupported(): boolean
  speak(text: string, opts: SpeakOptions, handlers: SpeakHandlers): void
  /** Stop current output without firing onEnd/onError */
  cancel(): void
  /** True while output is playing or queued (used by the heartbeat) */
  isActive(): boolean
  /** Optional: warm up the next sentence while the current one plays */
  prefetch?(text: string, opts: SpeakOptions): void
}
