import { ref, readonly } from 'vue'
import { useReaderStore } from '../stores/reader'
import type { SpeakOptions, TTSEngine } from '../engines/types'
import { WebSpeechEngine } from '../engines/webSpeech'
import { CloudEngine } from '../engines/cloud'
import { resolveVoiceURI } from '../utils/voiceGender'
import { analyzeProsody, isSpeakable, NEUTRAL } from '../utils/prosody'
import { applyPronunciations, cleanForSpeech, parsePronunciations } from '../utils/pronounce'
import { DEFAULT_PRONUNCIATION_RULES } from '../utils/defaultPronunciations'
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
    // 代理模式：改打自家後端 /api/v1/tts，由後端持有金鑰與上游設定（金鑰不進瀏覽器，也避開 CORS）。
    // body 範本的 {{text}} 等佔位符由 cloud.ts 的 renderBody 代換成 JSON 值，
    // 欄位須與後端 TtsRequest（text / voice / rate / pitch）一致。
    return {
      endpoint: `${apiBase}/api/v1/tts`, apiKey: '', extraHeaders: '',
      bodyTemplate: '{"text":{{text}},"voice":{{voice}},"rate":{{rate}},"pitch":{{pitch}}}'
    }
  })

  // 【對接點 ④】啟動時問後端一次 GET /api/v1/tts/config，得知 provider。
  // provider === 'edge'：語速/音調由伺服器合成時套用，前端 <audio> 的 playbackRate 固定為 1，
  // 否則會重複加速。失敗時把旗標還原，下次再問。
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
  // 只有規則文字改變時才重新解析
  let rulesKey = '', rules: ReturnType<typeof parsePronunciations> = []
  /** 引擎要唸的文字：套用發音修正後的句子。 */
  function spoken(text: string) {
    const { pronunciationRules: raw, builtinPronunciations: builtin } = store.settings
    const key = `${builtin ? 1 : 0}\u0000${raw}`
    if (key !== rulesKey) {
      rulesKey = key
      // 使用者規則排前面：與內建規則長度相同時由使用者規則勝出
      rules = [...parsePronunciations(raw), ...(builtin ? DEFAULT_PRONUNCIATION_RULES : [])]
    }
    return cleanForSpeech(applyPronunciations(text, rules))
  }

  /** 單句的朗讀語氣；`following` 是接在它後面唸的句子（undefined = 章節結尾）。 */
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
    // 略過只有標點的行（分隔線、「……」），不送給引擎
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
      // 句間（語氣停頓）引擎是刻意閒置的；此時重唸會造成句子重複
      if (pauseTimer) return
      // 引擎丟掉了這句（瀏覽器 GC 的 bug）：沒有任何東西在進行 → 重新排程
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
    // speakCurrent 可能已立刻停止（不支援/未設定）
    if (store.playbackStatus === 'PLAYING') startHeartbeat()
  }
  function pause() {
    if (store.playbackStatus !== 'PLAYING') return
    token++
    clearPause()
    engine().cancel() // 在各引擎上，取消後重播該句比 pause() 更可靠
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
  /** 重唸目前這句，讓更改後的引擎/語速/音調/語音生效。 */
  function refresh() {
    if (store.playbackStatus === 'PLAYING') { webSpeech?.cancel(); cloud?.cancel(); speakCurrent() }
  }

  return {
    voices: readonly(voices), lastError: readonly(lastError),
    supported: webSpeech.isSupported(),
    play, pause, resume, stop, seekTo, next, prev, toggle, refresh
  }
}

// 開發時的熱重載會重新執行此模組，舊的計時器/引擎會跟新的一起繼續播放，所以要清掉
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearPause()
    if (heartbeat) clearInterval(heartbeat)
    webSpeech?.cancel()
    cloud?.cancel()
  })
}
