<template>
  <div class="app-root min-h-screen transition-colors" :data-theme="store.settings.theme"
       @dragover.prevent @drop.prevent="onDrop">
    <!-- Library / empty state -->
    <main v-if="!store.chapters.length" class="mx-auto max-w-2xl p-8">
      <h1 class="mb-2 text-3xl font-bold">Web Audio Reader</h1>
      <p class="mb-6 opacity-70">拖入或選擇 .acsm / .epub / .txt / .md 檔案開始朗讀</p>
      <label class="flex h-40 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed">
        <input type="file" class="hidden" accept=".acsm,.epub,.pdf,.txt,.md" @change="onPick">
        <span>{{ lib.status.value || '點擊或拖放檔案到此' }}</span>
      </label>
      <p v-if="lib.error.value" class="mt-3 text-red-600">{{ lib.error.value }}</p>
      <ul class="mt-8 space-y-2">
        <li v-for="b in lib.books.value" :key="b.id" class="flex items-center justify-between rounded border p-3">
          <button class="text-left" @click="lib.openSaved(b.id)">
            <div class="font-semibold">{{ b.title }}</div>
            <div class="text-xs opacity-60">{{ b.author }} · {{ b.format }}</div>
          </button>
          <button class="text-xs text-red-600" @click="lib.remove(b.id)">刪除</button>
        </li>
      </ul>
    </main>

    <!-- Reader -->
    <template v-else>
      <header class="ui-bar sticky top-0 z-10">
        <div class="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2">
          <button class="ui-btn" aria-label="返回書庫" @click="closeBook">‹ 書庫</button>
          <div class="min-w-0 flex-1 text-center">
            <div class="truncate text-xs opacity-60">{{ store.bookTitle }}</div>
            <select class="ui-select max-w-full truncate text-sm font-medium" :value="store.chapterIndex"
                    aria-label="章節" @change="jumpChapter(+($event.target as HTMLSelectElement).value)">
              <option v-for="(c, i) in store.chapters" :key="c.id" :value="i">{{ c.title }}</option>
            </select>
          </div>
          <span class="w-10 text-right text-xs tabular-nums opacity-70">{{ store.percentage }}%</span>
        </div>
        <div class="progress"><div class="progress-fill" :style="{ width: store.percentage + '%' }" /></div>
      </header>

      <ReaderView @seek="i => reader.seekTo(i)" />

      <template v-if="showSettings">
        <div class="fixed inset-0 z-10" @click="showSettings = false" />
        <SettingsPanel :voices="reader.voices.value" @tts="reader.refresh" />
      </template>
      <footer class="ui-bar fixed inset-x-0 bottom-0 z-20 border-t">
        <div class="mx-auto flex max-w-md items-center justify-center gap-2 p-2">
          <button class="ui-btn" aria-label="上一章" :disabled="store.chapterIndex === 0" @click="jumpChapter(store.chapterIndex - 1)">⏮︎</button>
          <button class="ui-btn text-lg" aria-label="上一句" @click="reader.prev()">◀</button>
          <button class="play-btn" :aria-label="store.playbackStatus === 'PLAYING' ? '暫停' : '播放'" @click="reader.toggle()">
            {{ store.playbackStatus === 'PLAYING' ? '❚❚' : '▶' }}
          </button>
          <button class="ui-btn text-lg" aria-label="下一句" @click="reader.next()">▶</button>
          <button class="ui-btn" aria-label="下一章" :disabled="store.chapterIndex >= store.chapters.length - 1" @click="jumpChapter(store.chapterIndex + 1)">⏭︎</button>
          <button class="ui-btn ml-2" :class="{ 'ui-btn-on': showSettings }" aria-label="設定" @click="showSettings = !showSettings">Aa</button>
        </div>
      </footer>
      <p v-if="reader.lastError.value || (!reader.supported && store.settings.ttsEngine === 'webspeech')"
         class="fixed top-16 inset-x-0 z-30 bg-red-600 p-2 text-center text-sm text-white">
        {{ reader.lastError.value || '此瀏覽器不支援 Web Speech API，請改用雲端 TTS' }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useReaderStore } from './stores/reader'
import { useSpeechReader } from './composables/useSpeechReader'
import { useDeviceControls } from './composables/useDeviceControls'
import { useLibrary } from './composables/useLibrary'

const store = useReaderStore()
const reader = useSpeechReader()
const lib = useLibrary()
const showSettings = ref(false)

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) lib.importFile(f)
}
function onDrop(e: DragEvent) {
  const f = e.dataTransfer?.files?.[0]
  if (f) lib.importFile(f)
}
function jumpChapter(i: number) {
  // Manually switching chapters stops the current speech; the user presses play to start the new one
  reader.stop()
  store.setPosition(i, 0)
}
async function closeBook() {
  reader.stop()
  await lib.saveProgress()
  store.chapters = []
  store.currentBookId = null
}

onMounted(() => {
  store.loadSettings()
  lib.refresh()
  useDeviceControls({ play: reader.play, pause: reader.pause, next: reader.next, prev: reader.prev })
})

watch(() => store.settings, () => store.saveSettings(), { deep: true })

// Persist progress (debounced)
let t: ReturnType<typeof setTimeout> | undefined
watch(() => [store.chapterIndex, store.sentenceIndex], () => {
  clearTimeout(t)
  t = setTimeout(() => lib.saveProgress(), 800)
})
</script>
