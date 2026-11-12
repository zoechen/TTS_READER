import { ref, readonly } from 'vue'
import { useReaderStore } from '../stores/reader'
import type { SpeakOptions, TTSEngine } from '../engines/types'
import { WebSpeechEngine } from '../engines/webSpeech'
import { CloudEngine } from '../engines/cloud'
import { resolveVoiceURI } from '../utils/voiceGender'

const voices = ref<SpeechSynthesisVoice[]>([])
const lastError = ref('')
let token = 0
let lastEventAt = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let bound = false
let webSpeech: WebSpeechEngine | null = null
let cloud: CloudEngine | null = null

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
      bodyTemplate: '{"text":{{text}},"voice":{{voice}},"rate":{{rate}}}'
    }
  })

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
  const opts = (): SpeakOptions => ({
    rate: store.settings.ttsRate,
    pitch: store.settings.ttsPitch,
    voice: voiceFor()
  })

  function peekNext() {
    const e = engine()
    if (!e.prefetch) return
    const i = store.sentenceIndex + 1
    const s = store.sentences[i] ?? store.chapters[store.chapterIndex + 1]?.sentences[0]
    if (s) e.prefetch(s.text, opts())
  }

  function speakCurrent() {
    const sentence = store.currentSentence
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
    e.cancel()
    lastEventAt = Date.now()
    e.speak(sentence.text, opts(), {
      onStart: () => { peekNext() },
      onActivity: () => { lastEventAt = Date.now() },
      onEnd: () => {
        if (myToken !== token || store.playbackStatus !== 'PLAYING') return
        if (store.next()) speakCurrent()
        else stop()
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
    engine().cancel() // cancel + replay sentence is more reliable than pause() across engines
    store.setPlaybackStatus('PAUSED')
    stopHeartbeat()
  }
  function resume() { if (store.playbackStatus === 'PAUSED') play() }
  function stop() {
    token++
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
