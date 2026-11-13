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
  /** true when this sentence starts a new paragraph */
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
  /** true: call this app's backend /api/v1/tts proxy (key stays on the server) */
  useProxy: boolean
  endpoint: string
  apiKey: string
  voice: string
  /** Voice used when gender = female / male (falls back to `voice` when empty) */
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
  /** Web Speech voice (voiceURI or name) to use for each gender preference */
  voiceMap: Record<'any' | 'female' | 'male', string>
  voiceGender: 'any' | 'female' | 'male'
  theme: 'light' | 'sepia' | 'dark'
  fontSize: number
  lineHeight: number
  fontFamily: 'sans' | 'serif' | 'kai'
  autoScroll: boolean
  /** Adjust rate / pitch / pauses per sentence (questions, exclamations, dialogue, paragraph ends) */
  expressive: boolean
  /** Reading column width */
  pageWidth: 'narrow' | 'normal' | 'wide'
}
