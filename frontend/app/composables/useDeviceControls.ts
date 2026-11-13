import { watch } from 'vue'
import { useReaderStore } from '../stores/reader'

/** Media Session + 螢幕喚醒鎖，依播放狀態驅動。 */
export function useDeviceControls(h: { play(): void; pause(): void; next(): void; prev(): void }) {
  const store = useReaderStore()
  let lock: WakeLockSentinel | null = null

  async function acquire() {
    try {
      if ('wakeLock' in navigator && !lock) {
        lock = await navigator.wakeLock.request('screen')
        lock.addEventListener('release', () => { lock = null })
      }
    } catch { /* denied / unsupported */ }
  }
  async function release() {
    try { await lock?.release() } catch { /* ignore */ }
    lock = null
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession
    const set = (a: MediaSessionAction, fn: () => void) => { try { ms.setActionHandler(a, fn) } catch { /* ignore */ } }
    set('play', h.play)
    set('pause', h.pause)
    set('previoustrack', h.prev)
    set('nexttrack', h.next)
  }

  watch(() => store.playbackStatus, (s) => {
    if (s === 'PLAYING') acquire(); else release()
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = s === 'PLAYING' ? 'playing' : s === 'PAUSED' ? 'paused' : 'none'
    }
  })

  watch(() => [store.bookTitle, store.chapter?.title], () => {
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: store.bookTitle,
        artist: store.bookAuthor,
        album: store.chapter?.title ?? ''
      })
    }
  }, { immediate: true })

  // 分頁隱藏時喚醒鎖會被釋放；回到分頁時重新取得
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.playbackStatus === 'PLAYING') acquire()
  })
}
