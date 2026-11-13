export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'acsm'

export interface BookMetadata {
  id: string
  title: string
  author: string
  coverBlob?: Blob
  format: BookFormat
  fileSize: number
  totalChapters: number
  createdAt: number
  lastReadAt: number
}

export interface SentenceItem {
  id: string
  order: number
  text: string
  chapterId: string
  /** 這一句是新段落的開頭時為 true */
  paraStart?: boolean
  domSelector?: string
}

export interface Chapter {
  id: string
  title: string
  order: number
  sentences: SentenceItem[]
  rawContent?: string
}

export interface ReadProgress {
  bookId: string
  chapterId: string
  sentenceIndex: number
  percentage: number
  updatedAt: number
}

export interface CloudSettings {
  /** true：呼叫本 App 後端的 /api/v1/tts 代理（金鑰留在伺服器） */
  useProxy: boolean
  endpoint: string
  apiKey: string
  voice: string
  /** 性別選女聲/男聲時使用的語音（留空則退回 `voice`） */
  voiceFemale: string
  voiceMale: string
  bodyTemplate: string
  extraHeaders: string
}

export interface ReaderSettings {
  ttsEngine: 'webspeech' | 'cloud'
  cloud: CloudSettings
  ttsRate: number
  ttsPitch: number
  /** 各性別偏好所使用的 Web Speech 語音（voiceURI 或名稱） */
  voiceMap: Record<'any' | 'female' | 'male', string>
  voiceGender: 'any' | 'female' | 'male'
  theme: 'light' | 'sepia' | 'dark'
  fontSize: number
  lineHeight: number
  fontFamily: 'sans' | 'serif' | 'kai'
  autoScroll: boolean
  /** 依每句內容調整語速/音調/停頓（問句、驚嘆、對話、段落結尾） */
  expressive: boolean
  /** Pronunciation fixes, one `原文=讀成` per line (see utils/pronounce.ts) */
  pronunciationRules: string
  /** 同時套用內建字典（utils/defaultPronunciations.ts） */
  builtinPronunciations: boolean
  /** 閱讀欄寬 */
  pageWidth: 'narrow' | 'normal' | 'wide'
}
