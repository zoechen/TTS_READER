<template>
  <div class="panel fixed inset-x-0 bottom-16 z-20 mx-auto max-h-[70vh] max-w-md space-y-3 overflow-y-auto rounded-t-xl p-4 text-sm shadow-xl">
    <label class="block">語音引擎
      <select v-model="s.ttsEngine" class="w-full rounded border p-1" @change="emit('tts')">
        <option value="webspeech">瀏覽器內建 (Web Speech)</option>
        <option value="cloud">雲端 TTS（Edge 神經語音，需啟動後端）</option>
      </select>
    </label>
    <fieldset v-if="s.ttsEngine === 'cloud'" class="space-y-2 rounded border p-2">
      <label class="flex items-center gap-2"><input v-model="s.cloud.useProxy" type="checkbox"> 使用伺服器代理 (Key 存在後端)</label>
      <template v-if="!s.cloud.useProxy">
      <label class="block">端點 URL (POST，回傳音訊)
        <input v-model="s.cloud.endpoint" type="url" placeholder="https://..." class="w-full rounded border p-1">
      </label>
      <label class="block">API Key (以 Bearer 傳送，僅存於本機瀏覽器)
        <input v-model="s.cloud.apiKey" type="password" autocomplete="off" class="w-full rounded border p-1">
      </label>
      </template>
      <label class="block">預設語音名稱 / ID (代理模式留空則用伺服器預設)
        <input v-model="s.cloud.voice" class="w-full rounded border p-1" @change="emit('tts')">
      </label>
      <div class="grid grid-cols-2 gap-2">
        <label class="block">女聲語音 ID
          <input v-model="s.cloud.voiceFemale" class="w-full rounded border p-1" @change="emit('tts')">
        </label>
        <label class="block">男聲語音 ID
          <input v-model="s.cloud.voiceMale" class="w-full rounded border p-1" @change="emit('tts')">
        </label>
      </div>
      <template v-if="!s.cloud.useProxy">
      <label class="block">請求內容模板 (JSON，可用 <code v-pre>{{text}} {{voice}} {{rate}}</code>)
        <textarea v-model="s.cloud.bodyTemplate" rows="2" class="w-full rounded border p-1 font-mono text-xs" />
      </label>
      <label class="block">額外 Header (JSON，選填)
        <input v-model="s.cloud.extraHeaders" placeholder='{"x-api-key":"..."}' class="w-full rounded border p-1 font-mono text-xs">
      </label>
      </template>
    </fieldset>
    <label class="block">聲音性別
      <select v-model="s.voiceGender" class="w-full rounded border p-1" @change="emit('tts')">
        <option value="any">不限</option><option value="female">女聲</option><option value="male">男聲</option>
      </select>
    </label>
    <label class="flex items-center gap-2"><input v-model="s.expressive" type="checkbox" @change="emit('tts')"> 情感語調（依問句、驚嘆、對話調整語氣與停頓）</label>
    <details class="rounded border p-2" style="border-color: var(--border)">
      <summary class="cursor-pointer">發音修正（破音字）</summary>
      <p class="mt-2 text-xs opacity-70">每行一條：<code>原文=讀成</code>。朗讀時把原文換成較容易讀對的同音字，畫面上的文字不變。<code>#</code> 開頭為註解，越長的詞優先套用。不確定讀音時可到<a href="https://www.moedict.tw/" target="_blank" rel="noopener" class="underline">萌典</a>查詢該詞的注音。</p>
      <label class="mt-2 flex items-center gap-2"><input v-model="s.builtinPronunciations" type="checkbox" @change="emit('tts')"> 使用內建字典（收錄「行」「長」「了」）</label>
      <textarea v-model="s.pronunciationRules" rows="6" spellcheck="false" class="mt-2 w-full rounded border p-1 font-mono text-xs"
                placeholder="# 例：&#10;某詞=同音字詞" @change="emit('tts')" />
    </details>
    <label class="block">語速 {{ s.ttsRate.toFixed(1) }}x
      <input v-model.number="s.ttsRate" type="range" min="0.5" max="2.5" step="0.1" class="w-full" @change="emit('tts')">
    </label>
    <label v-if="s.ttsEngine === 'webspeech'" class="block">音調 {{ s.ttsPitch.toFixed(1) }}
      <input v-model.number="s.ttsPitch" type="range" min="0.8" max="1.2" step="0.1" class="w-full" @change="emit('tts')">
    </label>
    <label v-if="s.ttsEngine === 'webspeech'" class="block">語音（{{ genderLabel }}專用，各性別可分別指定）
      <select v-model="s.voiceMap[s.voiceGender]" class="w-full rounded border p-1" @change="emit('tts')">
        <option value="">預設 (zh-TW 優先)</option>
        <option v-for="v in shownVoices" :key="v.voiceURI" :value="v.voiceURI">{{ v.name }} ({{ v.lang }})</option>
      </select>
    </label>
    <div class="space-y-1">主題
      <div class="flex gap-2">
        <button v-for="t in themes" :key="t.v" class="swatch" :class="{ on: s.theme === t.v }"
                :style="{ background: t.bg, color: t.fg }" @click="s.theme = t.v">{{ t.label }}</button>
      </div>
    </div>
    <label class="block">字級 {{ s.fontSize }}px
      <input v-model.number="s.fontSize" type="range" min="14" max="28" step="1" class="w-full">
    </label>
    <label class="block">行距 {{ s.lineHeight.toFixed(1) }}
      <input v-model.number="s.lineHeight" type="range" min="1.5" max="2.2" step="0.1" class="w-full">
    </label>
    <div class="space-y-1">字體
      <div class="seg">
        <button v-for="o in fonts" :key="o.v" :class="{ on: s.fontFamily === o.v }" @click="s.fontFamily = o.v">{{ o.label }}</button>
      </div>
    </div>
    <div class="space-y-1">邊距
      <div class="seg">
        <button v-for="o in widths" :key="o.v" :class="{ on: s.pageWidth === o.v }" @click="s.pageWidth = o.v">{{ o.label }}</button>
      </div>
    </div>
    <label class="flex items-center gap-2"><input v-model="s.autoScroll" type="checkbox"> 自動捲動</label>
  </div>
</template>

<script setup lang="ts">
import { useReaderStore } from '../stores/reader'

import { computed } from 'vue'

const themes = [
  { v: 'light', label: '明亮', bg: '#fff', fg: '#1f2937' },
  { v: 'sepia', label: '護眼', bg: '#fbf0d9', fg: '#5f4b32' },
  { v: 'dark', label: '深色', bg: '#111827', fg: '#e5e7eb' }
] as const
const fonts = [{ v: 'serif', label: '襯線' }, { v: 'sans', label: '黑體' }, { v: 'kai', label: '楷體' }] as const
const widths = [{ v: 'wide', label: '窄邊距' }, { v: 'normal', label: '標準' }, { v: 'narrow', label: '寬邊距' }] as const
const props = defineProps<{ voices: readonly SpeechSynthesisVoice[] }>()
const emit = defineEmits<{ tts: [] }>()
const s = useReaderStore().settings
const genderLabel = computed(() => ({ any: '不限', female: '女聲', male: '男聲' }[s.voiceGender]))
// 中文語音排前面；每個語音都可指定給任一欄位
const shownVoices = computed(() =>
  [...props.voices].sort((a, b) => Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh'))))
</script>
