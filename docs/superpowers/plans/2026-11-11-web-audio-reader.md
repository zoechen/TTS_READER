# Web 語音朗讀閱讀器 (Web Audio Reader) 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立具備 ACSM 一鍵兌換解密、標準電子書與文本解析、毫秒級音畫同步高亮朗讀以及 PWA/行動端支援的 Web 語音閱讀器。

**Architecture:** Client-Server 雙層架構：後端 FastAPI 服務負責通訊 Adobe Content Server 解密 ACSM DRM 憑證；前端 Vue 3 + Nuxt 3 負責本地解析 (EPUB/PDF/TXT)、Pinia 狀態管理、IndexedDB 快取與 Web Speech API 分句連續朗讀。

**Tech Stack:** Python 3.11, FastAPI, libgourou (C++ toolchain), Nuxt 3 (Vue 3 + TS), Pinia, Dexie.js (IndexedDB), Tailwind CSS, Web Speech API, Media Session API, Screen Wake Lock API.

**Spec:** `SPEC.md`

## Global Constraints

- 後端 Python 版本: Python 3.11
- 前端框架: Nuxt 3 (Vue 3, TypeScript)
- 排版與樣式: Tailwind CSS
- 本地資料庫: IndexedDB (`dexie`)
- 音效引擎: Web Speech API (原生)
- Docker: 後端容器需整合 `libgourou` 工具鏈

---

### Task 1: 後端基礎架構修復與健康檢查端點 (Fix & Scaffold Backend Service)

**Files:**
- Create: `backend/Dockerfile`
- Modify: `backend/requirements.txt`
- Create: `backend/main.py`
- Test: `backend/tests/test_health.py`

**Interfaces:**
- Consumes: None
- Produces: FastAPI App HTTP Server on port 8000, `GET /health` endpoint returning `{"status": "ok", "version": "1.0.0"}`

- [ ] **Step 1: 建立後端依賴 `backend/requirements.txt`**

```txt
fastapi>=0.110.0
uvicorn[standard]>=0.28.0
python-multipart>=0.0.9
pytest>=8.0.0
httpx>=0.27.0
```

- [ ] **Step 2: 建立後端 `backend/Dockerfile`**

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    cmake \
    pkg-config \
    libssl-dev \
    libcurl4-openssl-dev \
    libzip-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://git.fslab.de/johannes/libgourou.git /tmp/libgourou && \
    cd /tmp/libgourou && \
    make && \
    make install && \
    ldconfig && \
    rm -rf /tmp/libgourou

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

VOLUME ["/root/.config/libgourou"]

EXPOSE 8000
ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 3: 寫入 failing 測試 `backend/tests/test_health.py`**

```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "1.0.0"}
```

- [ ] **Step 4: 實作 `backend/main.py` 的基礎架構與健康檢查**

```python
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("acsm-service")

app = FastAPI(title="ACSM Fulfillment Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {"status": "ok", "version": "1.0.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

- [ ] **Step 5: 執行測試確定驗證通過**

Run: `python3 -m pytest backend/tests/test_health.py`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/Dockerfile backend/requirements.txt backend/main.py backend/tests/test_health.py
git commit -m "feat(backend): fix requirements.txt and setup FastAPI health endpoint"
```

---

### Task 2: 後端 ACSM 履約解密 API (`/api/v1/acsm/fulfill`)

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_acsm.py`

**Interfaces:**
- Consumes: multipart/form-data with `.acsm` file
- Produces: `POST /api/v1/acsm/fulfill` returning binary octet-stream (EPUB/PDF) with headers `X-Book-Title`

- [ ] **Step 1: 寫入 ACSM 履約端點測試 `backend/tests/test_acsm.py`**

```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_fulfill_invalid_file_type():
    files = {"file": ("test.txt", b"hello world", "text/plain")}
    response = client.post("/api/v1/acsm/fulfill", files=files)
    assert response.status_code == 400
    assert "Invalid file type" in response.json()["detail"]
```

- [ ] **Step 2: 執行測試驗證失敗**

Run: `python3 -m pytest backend/tests/test_acsm.py`
Expected: FAIL (404 Not Found)

- [ ] **Step 3: 實作 `/api/v1/acsm/fulfill` 端點邏輯**

```python
import os
import shutil
import uuid
import subprocess
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse

STORAGE_BASE = Path("/tmp/acsm_work")
STORAGE_BASE.mkdir(parents=True, exist_ok=True)

@app.post("/api/v1/acsm/fulfill")
async def fulfill_acsm(file: UploadFile = File(...)):
    if not file.filename.endswith(".acsm"):
        raise HTTPException(status_code=400, detail="Invalid file type. Only .acsm files are accepted.")

    request_id = str(uuid.uuid4())
    work_dir = STORAGE_BASE / request_id
    work_dir.mkdir(parents=True, exist_ok=True)
    acsm_path = work_dir / "input.acsm"

    try:
        with acsm_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # Run acsmdownloader
        result = subprocess.run(
            ["acsmdownloader", "-f", str(acsm_path), "-o", str(work_dir)],
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            logger.error(f"acsmdownloader failed: {result.stderr}")
            raise HTTPException(status_code=502, detail=f"Adobe fulfillment failed: {result.stderr}")

        downloaded_files = [f for f in work_dir.iterdir() if f.suffix in [".epub", ".pdf"] and f.name != "input.acsm"]
        if not downloaded_files:
            raise HTTPException(status_code=500, detail="Downloaded file not found after fulfillment.")

        encrypted_file = downloaded_files[0]
        decrypted_file = work_dir / f"decrypted_{encrypted_file.name}"

        decrypt_result = subprocess.run(
            ["adept_decrypt", "-f", str(encrypted_file), "-o", str(decrypted_file)],
            capture_output=True,
            text=True
        )

        if decrypt_result.returncode != 0:
            logger.error(f"Decryption failed: {decrypt_result.stderr}")
            raise HTTPException(status_code=500, detail=f"DRM decryption failed: {decrypt_result.stderr}")

        def iterfile():
            with decrypted_file.open("rb") as f:
                yield from f
            shutil.rmtree(work_dir, ignore_errors=True)

        return StreamingResponse(
            iterfile(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{encrypted_file.name}"',
                "X-Book-Title": encrypted_file.stem
            }
        )

    except Exception as e:
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
        if isinstance(e, HTTPException):
            raise e
        logger.exception("Unexpected error during fulfillment")
        raise HTTPException(status_code=500, detail=str(e))
```

- [ ] **Step 4: 執行測試驗證通過**

Run: `python3 -m pytest backend/tests/test_acsm.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_acsm.py
git commit -m "feat(backend): implement ACSM fulfillment API endpoint"
```

---

### Task 3: 前端型別定義與基礎套件配置 (Frontend Setup & Type Definitions)

**Files:**
- Create: `frontend/types/reader.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/nuxt.config.ts`

**Interfaces:**
- Consumes: None
- Produces: `BookMetadata`, `SentenceItem`, `Chapter`, `ReadProgress`, `ReaderSettings` interfaces

- [ ] **Step 1: 安裝前端輔助依賴**

Run: `cd frontend && npm install @pinia/nuxt dexie @tailwindcss/vite`

- [ ] **Step 2: 建立 `frontend/types/reader.ts`**

```typescript
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

export interface ReaderSettings {
  ttsRate: number
  ttsPitch: number
  voiceURI: string
  theme: 'light' | 'sepia' | 'dark'
  fontSize: number
  lineHeight: number
  fontFamily: 'sans' | 'serif'
  autoScroll: boolean
}
```

- [ ] **Step 3: 配置 `frontend/nuxt.config.ts`**

```typescript
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css']
})
```

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/types/reader.ts frontend/nuxt.config.ts
git commit -m "feat(frontend): setup types and dependencies"
```

---

### Task 4: 切句與標點斷句引擎 (`utils/tokenizer.ts`)

**Files:**
- Create: `frontend/utils/tokenizer.ts`
- Test: `frontend/tests/tokenizer.test.ts`

**Interfaces:**
- Consumes: raw string & chapterId
- Produces: `tokenizeText(rawText: string, chapterId: string): SentenceItem[]`

- [ ] **Step 1: 撰寫切句引擎測試 `frontend/tests/tokenizer.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { tokenizeText } from '../utils/tokenizer'

describe('tokenizeText', () => {
  it('should split text by CJK punctuation correctly', () => {
    const text = '這是第一句話。這是第二句話！這是第三句？'
    const sentences = tokenizeText(text, 'chap_1')
    assert.strictEqual(sentences.length, 3)
    assert.strictEqual(sentences[0].text, '這是第一句話。')
    assert.strictEqual(sentences[1].text, '這是第二句話！')
    assert.strictEqual(sentences[2].text, '這是第三句？')
  })

  it('should split long sentences over 120 chars by commas', () => {
    const longText = 'A'.repeat(70) + '，' + 'B'.repeat(70) + '。'
    const sentences = tokenizeText(longText, 'chap_1')
    assert.isTrue(sentences.length >= 2)
  })
})
```

- [ ] **Step 2: 實作 `frontend/utils/tokenizer.ts`**

```typescript
import type { SentenceItem } from '~/types/reader'

export function tokenizeText(rawText: string, chapterId: string): SentenceItem[] {
  if (!rawText || !rawText.trim()) return []

  // Split by main sentence terminators
  const rawSegments = rawText.split(/(?<=[。！？；.!?:…\n])\s*/)
  const result: SentenceItem[] = []
  let order = 0

  for (const seg of rawSegments) {
    const trimmed = seg.trim()
    if (!trimmed) continue

    // Long sentence fallback (>120 chars)
    if (trimmed.length > 120) {
      const subSegments = trimmed.split(/(?<=[,，])\s*/)
      for (const sub of subSegments) {
        const subTrimmed = sub.trim()
        if (subTrimmed) {
          result.push({
            id: `${chapterId}_sent_${order}`,
            order,
            text: subTrimmed,
            chapterId
          })
          order++
        }
      }
    } else {
      result.push({
        id: `${chapterId}_sent_${order}`,
        order,
        text: trimmed,
        chapterId
      })
      order++
    }
  }

  return result
}
```

- [ ] **Step 3: 執行測試驗證**

Run: `cd frontend && npx vitest run tests/tokenizer.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/utils/tokenizer.ts frontend/tests/tokenizer.test.ts
git commit -m "feat(frontend): implement sentence tokenizer module with unit tests"
```

---

### Task 5: 狀態管理 Store 與 IndexedDB 資料庫 (`stores/reader.ts` & `utils/db.ts`)

**Files:**
- Create: `frontend/utils/db.ts`
- Create: `frontend/stores/reader.ts`

**Interfaces:**
- Consumes: IndexedDB Dexie db instance
- Produces: Pinia store for current book, sentences queue, playback status, settings

- [ ] **Step 1: 建立 IndexedDB 設定 `frontend/utils/db.ts`**

```typescript
import Dexie, { type Table } from 'dexie'
import type { BookMetadata, ReadProgress } from '~/types/reader'

export interface BookRecord extends BookMetadata {
  fileBlob: Blob
}

export class ReaderDatabase extends Dexie {
  books!: Table<BookRecord>
  progress!: Table<ReadProgress>

  constructor() {
    super('TTSReaderDB')
    this.version(1).stores({
      books: 'id, title, format, lastReadAt',
      progress: 'bookId, updatedAt'
    })
  }
}

export const db = new ReaderDatabase()
```

- [ ] **Step 2: 建立 Pinia Reader Store `frontend/stores/reader.ts`**

```typescript
import { defineStore } from 'pinia'
import type { SentenceItem, Chapter, ReaderSettings, ReadProgress } from '~/types/reader'

export type PlaybackStatus = 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED'

export const useReaderStore = defineStore('reader', {
  state: () => ({
    currentBookId: null as string | null,
    currentChapterId: null as string | null,
    chapters: [] as Chapter[],
    sentences: [] as SentenceItem[],
    currentSentenceIndex: 0,
    playbackStatus: 'IDLE' as PlaybackStatus,
    settings: {
      ttsRate: 1.0,
      ttsPitch: 1.0,
      voiceURI: '',
      theme: 'sepia',
      fontSize: 18,
      lineHeight: 1.8,
      fontFamily: 'sans',
      autoScroll: true
    } as ReaderSettings
  }),
  getters: {
    currentSentence(state): SentenceItem | null {
      return state.sentences[state.currentSentenceIndex] || null
    },
    totalSentences(state): number {
      return state.sentences.length
    }
  },
  actions: {
    setPlaybackStatus(status: PlaybackStatus) {
      this.playbackStatus = status
    },
    setSentences(sentences: SentenceItem[]) {
      this.sentences = sentences
      this.currentSentenceIndex = 0
    },
    setCurrentSentenceIndex(index: number) {
      if (index >= 0 && index < this.sentences.length) {
        this.currentSentenceIndex = index
      }
    },
    nextSentence(): boolean {
      if (this.currentSentenceIndex < this.sentences.length - 1) {
        this.currentSentenceIndex++
        return true
      }
      return false
    },
    prevSentence(): boolean {
      if (this.currentSentenceIndex > 0) {
        this.currentSentenceIndex--
        return true
      }
      return false
    }
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add frontend/utils/db.ts frontend/stores/reader.ts
git commit -m "feat(frontend): setup IndexedDB and Pinia reader store"
```

---

### Task 6: 語音朗讀控制器 Composable (`composables/useSpeechReader.ts`)

**Files:**
- Create: `frontend/composables/useSpeechReader.ts`

**Interfaces:**
- Consumes: Pinia Reader Store & Web Speech API (`window.speechSynthesis`)
- Produces: `{ play, pause, resume, stop, seekTo, availableVoices }`

- [ ] **Step 1: 實作 `frontend/composables/useSpeechReader.ts`**

```typescript
import { ref, onMounted, onUnmounted } from 'vue'
import { useReaderStore } from '~/stores/reader'

export function useSpeechReader() {
  const store = useReaderStore()
  const voices = ref<SpeechSynthesisVoice[]>([])
  let keepAliveInterval: number | null = null

  const loadVoices = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      voices.value = window.speechSynthesis.getVoices()
    }
  }

  const speakCurrentSentence = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    
    window.speechSynthesis.cancel()
    const sentence = store.currentSentence
    if (!sentence) {
      store.setPlaybackStatus('IDLE')
      return
    }

    const utterance = new SpeechSynthesisUtterance(sentence.text)
    utterance.rate = store.settings.ttsRate
    utterance.pitch = store.settings.ttsPitch

    if (store.settings.voiceURI) {
      const selectedVoice = voices.value.find(v => v.voiceURI === store.settings.voiceURI)
      if (selectedVoice) utterance.voice = selectedVoice
    }

    utterance.onend = () => {
      if (store.playbackStatus === 'PLAYING') {
        const hasNext = store.nextSentence()
        if (hasNext) {
          speakCurrentSentence()
        } else {
          store.setPlaybackStatus('IDLE')
        }
      }
    }

    utterance.onerror = (e) => {
      console.error('SpeechSynthesis error:', e)
      store.setPlaybackStatus('IDLE')
    }

    store.setPlaybackStatus('PLAYING')
    window.speechSynthesis.speak(utterance)
  }

  const startKeepAlive = () => {
    stopKeepAlive()
    keepAliveInterval = window.setInterval(() => {
      if (store.playbackStatus === 'PLAYING' && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause()
        window.speechSynthesis.resume()
      }
    }, 10000)
  }

  const stopKeepAlive = () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
    }
  }

  const play = () => {
    speakCurrentSentence()
    startKeepAlive()
  }

  const pause = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.pause()
      store.setPlaybackStatus('PAUSED')
      stopKeepAlive()
    }
  }

  const resume = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume()
        store.setPlaybackStatus('PLAYING')
        startKeepAlive()
      } else {
        play()
      }
    }
  }

  const stop = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      store.setPlaybackStatus('IDLE')
      stopKeepAlive()
    }
  }

  const seekTo = (index: number) => {
    store.setCurrentSentenceIndex(index)
    if (store.playbackStatus === 'PLAYING') {
      speakCurrentSentence()
    }
  }

  onMounted(() => {
    loadVoices()
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices
    }
  })

  onUnmounted(() => {
    stopKeepAlive()
  })

  return {
    voices,
    play,
    pause,
    resume,
    stop,
    seekTo
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/composables/useSpeechReader.ts
git commit -m "feat(frontend): implement useSpeechReader composable with Keep-Alive"
```

---

### Task 7: 閱讀器 UI 畫面與音畫同步組件 (`components/ReaderView.vue`)

**Files:**
- Create: `frontend/components/ReaderView.vue`

**Interfaces:**
- Consumes: Pinia Reader Store, `useSpeechReader` composable
- Produces: Visual reading canvas with active sentence yellow/dark highlight, smooth scrolling, and click-to-speech interaction.

- [ ] **Step 1: 實作 `frontend/components/ReaderView.vue`**

```vue
<template>
  <div 
    class="reader-container min-h-screen p-6 transition-colors duration-300"
    :class="themeClass"
  >
    <div class="max-w-3xl mx-auto space-y-4 text-lg leading-relaxed">
      <p
        v-for="(sentence, index) in store.sentences"
        :key="sentence.id"
        :id="sentence.id"
        class="sentence-item inline cursor-pointer rounded px-1 transition-all duration-200"
        :class="{
          'bg-yellow-200 dark:bg-yellow-800 font-medium scale-[1.01] shadow-sm': store.currentSentenceIndex === index,
          'hover:bg-gray-100 dark:hover:bg-gray-800': store.currentSentenceIndex !== index
        }"
        @click="onSentenceClick(index)"
      >
        {{ sentence.text }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick } from 'vue'
import { useReaderStore } from '~/stores/reader'
import { useSpeechReader } from '~/composables/useSpeechReader'

const store = useReaderStore()
const { seekTo } = useSpeechReader()

const themeClass = computed(() => {
  switch (store.settings.theme) {
    case 'dark': return 'bg-gray-900 text-gray-100'
    case 'sepia': return 'bg-[#fbf0d9] text-[#5f4b32]'
    default: return 'bg-white text-gray-900'
  }
})

const onSentenceClick = (index: number) => {
  seekTo(index)
}

// Smooth scroll lock protection logic
let isUserScrolling = false
let scrollTimeout: number | null = null

const handleUserScroll = () => {
  isUserScrolling = true
  if (scrollTimeout) clearTimeout(scrollTimeout)
  scrollTimeout = window.setTimeout(() => {
    isUserScrolling = false
  }, 4000)
}

watch(() => store.currentSentenceIndex, async (newIndex) => {
  if (!store.settings.autoScroll || isUserScrolling) return
  await nextTick()
  const sentence = store.sentences[newIndex]
  if (sentence) {
    const el = document.getElementById(sentence.id)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

if (typeof window !== 'undefined') {
  window.addEventListener('wheel', handleUserScroll, { passive: true })
  window.addEventListener('touchmove', handleUserScroll, { passive: true })
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/ReaderView.vue
git commit -m "feat(frontend): implement ReaderView component with audio-visual sentence sync"
```

---

### Task 8: 整合 App 主入口頁面 (`app/app.vue`)

**Files:**
- Modify: `frontend/app/app.vue`

**Interfaces:**
- Consumes: `FileUploader.vue`, `ReaderView.vue`, `useReaderStore`
- Produces: Complete SPA App layout with upload modal, playback toolbar, and reader panel.

- [ ] **Step 1: 實作 `frontend/app/app.vue`**

```vue
<template>
  <div class="app-layout min-h-screen flex flex-col font-sans">
    <header class="bg-slate-800 text-white p-4 flex justify-between items-center shadow-md">
      <h1 class="text-xl font-bold">Web Audio Reader</h1>
      <div class="flex items-center space-x-3">
        <button 
          @click="togglePlay"
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded font-semibold text-sm transition"
        >
          {{ store.playbackStatus === 'PLAYING' ? '暫停' : '播放' }}
        </button>
      </div>
    </header>

    <main class="flex-1">
      <ReaderView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useReaderStore } from '~/stores/reader'
import { useSpeechReader } from '~/composables/useSpeechReader'
import { tokenizeText } from '~/utils/tokenizer'
import ReaderView from '~/components/ReaderView.vue'

const store = useReaderStore()
const { play, pause } = useSpeechReader()

const togglePlay = () => {
  if (store.playbackStatus === 'PLAYING') {
    pause()
  } else {
    play()
  }
}

onMounted(() => {
  // Initialize sample text for immediate demo
  const sampleText = "歡迎使用 Web 語音朗讀閱讀器！這是一款支援跨裝置高亮同步語音朗讀的電子書工具。您可以拖入 ACSM、EPUB 或 TXT 檔案進行朗讀。點擊任何句子即可跳轉朗讀。"
  const sentences = tokenizeText(sampleText, 'demo_chap_1')
  store.setSentences(sentences)
})
</script>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/app/app.vue
git commit -m "feat(frontend): integrate app layout and initial reader demo view"
```
