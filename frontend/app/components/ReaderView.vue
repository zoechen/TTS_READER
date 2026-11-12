<template>
  <article
    class="reader-text mx-auto px-6 py-10 pb-40"
    :style="{ maxWidth: widths[store.settings.pageWidth], fontSize: store.settings.fontSize + 'px', lineHeight: store.settings.lineHeight, fontFamily }"
  >
    <h2 class="mb-8 text-center text-2xl font-bold leading-snug">{{ store.chapter?.title }}</h2>
    <p v-for="(para, pi) in paragraphs" :key="pi" class="para">
      <template v-for="x in para" :key="x.s.id">
        <span
          :id="x.s.id"
          class="sentence"
          :class="{ 'reading-active-sentence': x.i === store.sentenceIndex }"
          @click="emit('seek', x.i)"
        >{{ x.s.text }}</span>{{ ' ' }}
      </template>
    </p>
  </article>
</template>

<script setup lang="ts">
import { computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { SentenceItem } from '../types/reader'
import { useReaderStore } from '../stores/reader'

const emit = defineEmits<{ seek: [index: number] }>()
const store = useReaderStore()

const paragraphs = computed(() => {
  const out: { s: SentenceItem, i: number }[][] = []
  store.sentences.forEach((s, i) => {
    if (!out.length || s.paraStart) out.push([])
    out[out.length - 1]!.push({ s, i })
  })
  return out
})
const widths = { narrow: '36rem', normal: '46rem', wide: '60rem' }
const fontFamily = computed(() => ({
  serif: 'Georgia, "Noto Serif TC", "Songti TC", serif',
  sans: 'system-ui, "Noto Sans TC", "PingFang TC", sans-serif',
  kai: '"Kaiti TC", "BiauKai", "DFKai-SB", serif'
}[store.settings.fontFamily]))

// Scroll lockout: pause auto-scroll for 4s after manual scrolling
let lockedUntil = 0
const lock = () => { lockedUntil = Date.now() + 4000 }
const events = ['wheel', 'touchmove', 'keydown'] as const
onMounted(() => events.forEach(e => window.addEventListener(e, lock, { passive: true })))
onBeforeUnmount(() => events.forEach(e => window.removeEventListener(e, lock)))

async function scrollToActive() {
  await nextTick()
  const s = store.currentSentence
  if (!s) return
  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

watch(() => [store.chapterIndex, store.sentenceIndex], () => {
  if (store.settings.autoScroll && Date.now() >= lockedUntil) scrollToActive()
})
// Jumping chapters / opening a book always scrolls
watch(() => store.chapterIndex, () => { lockedUntil = 0; scrollToActive() })
</script>
