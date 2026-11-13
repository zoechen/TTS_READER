export interface SpeakOptions {
  rate: number
  pitch: number
  /** 各引擎自己的語音識別碼（Web Speech 用 voiceURI，雲端用語音名稱/ID） */
  voice: string
  /** 這一句的音調變化百分比（0 = 不變） */
  pitchPct?: number
}

export interface SpeakHandlers {
  onStart?: () => void
  /** 有進度事件時呼叫，讓保活心跳知道引擎還活著 */
  onActivity?: () => void
  onEnd: () => void
  /** 只用於真正的失敗；取消時不可呼叫 onError */
  onError: (message: string) => void
}

/** 策略介面：一次朗讀一句。 */
export interface TTSEngine {
  readonly id: 'webspeech' | 'cloud'
  isSupported(): boolean
  speak(text: string, opts: SpeakOptions, handlers: SpeakHandlers): void
  /** 停止目前的輸出，且不觸發 onEnd/onError */
  cancel(): void
  /** 輸出正在播放或排隊中時為 true（供心跳使用） */
  isActive(): boolean
  /** 選用：目前這句播放時先暖機下一句 */
  prefetch?(text: string, opts: SpeakOptions): void
}
