import { defineStore } from 'pinia'
import type { Chapter, ReaderSettings, SentenceItem } from '../types/reader'

export type PlaybackStatus = 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED'

const SETTINGS_KEY = 'tts-reader-settings'

export const defaultSettings = (): ReaderSettings => ({
  ttsEngine: 'webspeech',
  cloud: { useProxy: true, endpoint: '', apiKey: '', voice: '', voiceFemale: 'zh-TW-HsiaoChenNeural', voiceMale: 'zh-CN-YunxiNeural', bodyTemplate: '{"input":{{text}},"voice":{{voice}}}', extraHeaders: '' },
  ttsRate: 1.0,
  ttsPitch: 1.0,
  voiceMap: { any: 'Shelley (中文（台灣）)', female: 'Google 國語（臺灣）', male: 'Rocko (中文（台灣）)' },
  voiceGender: 'any',
  theme: 'sepia',
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'serif',
  autoScroll: true,
  expressive: true,
  pronunciationRules: '',
  builtinPronunciations: true,
  pageWidth: 'normal'
})

export const useReaderStore = defineStore('reader', {
  state: () => ({
    currentBookId: null as string | null,
    bookTitle: '',
    bookAuthor: '',
    chapters: [] as Chapter[],
    chapterIndex: 0,
    sentenceIndex: 0,
    playbackStatus: 'IDLE' as PlaybackStatus,
    settings: defaultSettings()
  }),
  getters: {
    chapter(s): Chapter | null { return s.chapters[s.chapterIndex] ?? null },
    sentences(): SentenceItem[] { return this.chapter?.sentences ?? [] },
    currentSentence(): SentenceItem | null { return this.sentences[this.sentenceIndex] ?? null },
    percentage(s): number {
      if (!s.chapters.length) return 0
      const within = this.sentences.length ? this.sentenceIndex / this.sentences.length : 0
      return Math.round(((s.chapterIndex + within) / s.chapters.length) * 100)
    }
  },
  actions: {
    loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw) {
          const saved = JSON.parse(raw)
          const d = defaultSettings()
          this.settings = { ...d, ...saved, cloud: { ...d.cloud, ...saved.cloud }, voiceMap: { ...d.voiceMap, ...saved.voiceMap } }
        }
      } catch { /* ignore */ }
    },
    saveSettings() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)) } catch { /* ignore */ }
    },
    openBook(id: string, title: string, author: string, chapters: Chapter[], chapterIndex = 0, sentenceIndex = 0) {
      this.currentBookId = id
      this.bookTitle = title
      this.bookAuthor = author
      this.chapters = chapters
      this.playbackStatus = 'IDLE'
      this.setPosition(chapterIndex, sentenceIndex)
    },
    setPosition(chapterIndex: number, sentenceIndex = 0) {
      const ci = Math.min(Math.max(chapterIndex, 0), Math.max(this.chapters.length - 1, 0))
      this.chapterIndex = ci
      const len = this.chapters[ci]?.sentences.length ?? 0
      this.sentenceIndex = Math.min(Math.max(sentenceIndex, 0), Math.max(len - 1, 0))
    },
    setPlaybackStatus(status: PlaybackStatus) { this.playbackStatus = status },
    /** 前進一句，可跨章節。到全書結尾時回傳 false。 */
    next(): boolean {
      if (this.sentenceIndex < this.sentences.length - 1) { this.sentenceIndex++; return true }
      for (let c = this.chapterIndex + 1; c < this.chapters.length; c++) {
        if (this.chapters[c]!.sentences.length) { this.setPosition(c, 0); return true }
      }
      return false
    },
    prev(): boolean {
      if (this.sentenceIndex > 0) { this.sentenceIndex--; return true }
      for (let c = this.chapterIndex - 1; c >= 0; c--) {
        const n = this.chapters[c]!.sentences.length
        if (n) { this.setPosition(c, n - 1); return true }
      }
      return false
    }
  }
})
