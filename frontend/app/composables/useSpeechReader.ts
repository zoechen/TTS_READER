import { ref, readonly } from 'vue'
import { useReaderStore } from '../stores/reader'
import type { SpeakOptions, TTSEngine } from '../engines/types'
import { WebSpeechEngine } from '../engines/webSpeech'
import { CloudEngine } from '../engines/cloud'
import { resolveVoiceURI } from '../utils/voiceGender'
import { analyzeProsody, isSpeakable, NEUTRAL } from '../utils/prosody'
import { applyPronunciations, cleanForSpeech, parsePronunciations } from '../utils/pronounce'
import type { SentenceItem } from '../types/reader'

const voices = ref<SpeechSynthesisVoice[]>([])
const lastError = ref('')
let token = 0
let lastEventAt = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let bound = false
let webSpeech: WebSpeechEngine | null = null
let cloud: CloudEngine | null = null
let pauseTimer: ReturnType<typeof setTimeout> | null = null
let providerChecked = false
const clearPause = () => { if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null } }

export function useSpeechReader() {
  const store = useReaderStore()

  const apiBase = useRuntimeConfig().public.acsmApiBase
  webSpeech ??= new WebSpeechEngine()
  cloud ??= new CloudEngine(() => {
    const c = store.settings.cloud
    if (!c.useProxy) return c
    // Proxy mode: backend holds the provider key, URL and body template
    return {
      endpoint: `${apiBase}/api/v1/tts`, apiKey: '', extraHeaders: '',
      bodyTemplate: '{"text":{{text}},"voice":{{voice}},"rate":{{rate}},"pitch":{{pitch}}}'
    }
  })

  // Edge provider synthesizes with the requested rate/pitch itself; ask the backend once.
  if (!providerChecked && import.meta.client) {
    providerChecked = true
    fetch(`${apiBase}/api/v1/tts/config`).then(r => r.json())
      .then(j => { cloud!.serverProsody = j?.provider === 'edge' })
      .catch(() => { providerChecked = false })
  }

  if (!bound && webSpeech.isSupported()) {
    bound = true
    const load = () => { webSpeech!.loadVoices(); voices.value = webSpeech!.voices }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
  }

  const engine = (): TTSEngine => (store.settings.ttsEngine === 'cloud' ? cloud! : webSpeech!)
  function voiceFor(): string {
    const st = store.settings
    if (st.ttsEngine === 'cloud') {
      const c = st.cloud
      const g = st.voiceGender === 'female' ? c.voiceFemale : st.voiceGender === 'male' ? c.voiceMale : ''
      return g || c.voice
    }
    return resolveVoiceURI(voices.value, st.voiceMap[st.voiceGender], st.voiceGender)
  }
  // Re-parse only when the rule text changes
  let rulesRaw = '', rules: ReturnType<typeof parsePronunciations> = []
  /** Text the engine should read: the sentence with pronunciation fixes applied. */
  function spoken(text: string) {
    const raw = store.settings.pronunciationRules
    if (raw !== rulesRaw) { rulesRaw = raw; rules = parsePronunciations(raw) }
    return cleanForSpeech(applyPronunciations(text, rules))
  }

  /** Delivery for one sentence; `following` is the sentence read after it (undefined = end of chapter). */
  function prosodyFor(s: SentenceItem, following?: SentenceItem) {
    if (!store.settings.expressive) return NEUTRAL
    return analyzeProsody(s.text, { nextIsParaStart: !following || !!following.paraStart })
  }
  const opts = (s?: SentenceItem, following?: SentenceItem): SpeakOptions => {
    const p = s ? prosodyFor(s, following) : NEUTRAL
    const st = store.settings
    return {
      rate: Math.min(Math.max(st.ttsRate * p.rateMul, 0.5), 2.5),
      pitch: st.ttsPitch,
      pitchPct: p.pitchPct,
      voice: voiceFor()
    }
  }

  function peekNext() {
    const e = engine()
    if (!e.prefetch) return
    const i = store.sentenceIndex + 1
    const inChapter = store.sentences[i]
    const s = inChapter ?? store.chapters[store.chapterIndex + 1]?.sentences[0]
    if (s) e.prefetch(spoken(s.text), opts(s, inChapter ? store.sentences[i + 1] : store.chapters[store.chapterIndex + 1]?.sentences[1]))
  }

  function speakCurrent() {
    let sentence = store.currentSentence
    // Skip punctuation-only lines (separators, "……") instead of sending them to the engine
    while (sentence && !isSpeakable(sentence.text)) {
      if (!store.next()) { stop(); return }
      sentence = store.currentSentence
    }
    if (!sentence) { stop(); return }
    const e = engine()
    if (!e.isSupported()) {
      lastError.value = e.id === 'cloud' ? '尚未設定雲端 TTS 端點' : '此瀏覽器不支援 Web Speech API'
      stop(); return
    }
    if (e.id === 'webspeech' && voices.value.length && store.settings.voiceMap[store.settings.voiceGender] && !voiceFor()) {
      lastError.value = `找不到指定的語音「${store.settings.voiceMap[store.settings.voiceGender]}」，改用預設語音`
    }
    const myToken = ++token
    clearPause()
    e.cancel()
    lastEventAt = Date.now()
    const following = store.sentences[store.sentenceIndex + 1]
    const pauseMs = store.settings.expressive ? prosodyFor(sentence, following).pauseAfterMs : 0
    e.speak(spoken(sentence.text), opts(sentence, following), {
      onStart: () => { peekNext() },
      onActivity: () => { lastEventAt = Date.now() },
      onEnd: () => {
        if (myToken !== token || store.playbackStatus !== 'PLAYING') return
        const advance = () => {
          if (myToken !== token || store.playbackStatus !== 'PLAYING') return
          if (store.next()) speakCurrent()
          else stop()
        }
        if (pauseMs > 0) pauseTimer = setTimeout(() => { pauseTimer = null; advance() }, pauseMs)
        else advance()
      },
      onError: (msg) => {
        if (myToken !== token) return
        console.error('TTS error:', msg)
        lastError.value = msg
        stop()
      }
    })
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeat = setInterval(() => {
      if (store.playbackStatus !== 'PLAYING') return
      // Between sentences (prosody pause) the engine is idle on purpose; re-speaking now would repeat the sentence
      if (pauseTimer) return
      // Engine dropped the utterance (browser GC bug): nothing active -> reschedule
      if (!engine().isActive() && Date.now() - lastEventAt > 10000) speakCurrent()
    }, 10000)
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
  }

  function play() {
    if (!store.currentSentence) return
    lastError.value = ''
    store.setPlaybackStatus('PLAYING')
    speakCurrent()
    // speakCurrent may have stopped immediately (unsupported / not configured)
    if (store.playbackStatus === 'PLAYING') startHeartbeat()
  }
  function pause() {
    if (store.playbackStatus !== 'PLAYING') return
    token++
    clearPause()
    engine().cancel() // cancel + replay sentence is more reliable than pause() across engines
    store.setPlaybackStatus('PAUSED')
    stopHeartbeat()
  }
  function resume() { if (store.playbackStatus === 'PAUSED') play() }
  function stop() {
    token++
    clearPause()
    webSpeech?.cancel()
    cloud?.cancel()
    store.setPlaybackStatus('IDLE')
    stopHeartbeat()
  }
  function seekTo(index: number, chapterIndex = store.chapterIndex) {
    store.setPosition(chapterIndex, index)
    if (store.playbackStatus === 'PLAYING') speakCurrent()
    else play()
  }
  function next() {
    if (!store.next()) return stop()
    if (store.playbackStatus === 'PLAYING') speakCurrent()
  }
  function prev() {
    if (!store.prev()) return
    if (store.playbackStatus === 'PLAYING') speakCurrent()
  }
  function toggle() {
    if (store.playbackStatus === 'PLAYING') pause()
    else if (store.playbackStatus === 'PAUSED') resume()
    else play()
  }
  /** Re-speak current sentence so a changed engine/rate/pitch/voice takes effect. */
  function refresh() {
    if (store.playbackStatus === 'PLAYING') { webSpeech?.cancel(); cloud?.cancel(); speakCurrent() }
  }

  return {
    voices: readonly(voices), lastError: readonly(lastError),
    supported: webSpeech.isSupported(),
    play, pause, resume, stop, seekTo, next, prev, toggle, refresh
  }
}

// Dev hot-reload re-evaluates this module and would leave the old timers/engines playing alongside the new ones
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearPause()
    if (heartbeat) clearInterval(heartbeat)
    webSpeech?.cancel()
    cloud?.cancel()
  })
}
