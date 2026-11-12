# Web 語音朗讀閱讀器（Web Audio Reader）系統規格文件 (PRD & Tech Spec)

**版本**：v1.2.0  
**日期**：2026-11-11  
**架構架構**：Client-Server 雙層混合架構（Vue 3 前端 + Python/FastAPI ACSM 中繼解密服務）  
**目標**：提供無縫匯入標準電子書（EPUB/PDF/TXT）與 Adobe 授權憑證（`.acsm`），自動兌換、解密並在瀏覽器實現字幕級高亮與語音朗讀。

---

## 1. 專案概述 (Project Overview)

### 1.1 產品定位
一個支援跨裝置、具備自動版權憑證兌換功能的現代化網頁電子書語音閱讀器。針對日常購書取得的 `.acsm` 憑證檔，系統提供「拖入即兌換、解密並開始朗讀」的自動化流程，結合瀏覽器端朗讀與精準音畫同步，打造流暢的「聽書」體驗。

### 1.2 核心目標
* **ACSM 一鍵兌換與無縫解密（Zero-friction Ingestion）**：使用者只需拖入 `.acsm`，後端自動完成 Adobe Content Server 通訊、下載原檔、解密 Adept DRM 並交付前端。
* **高精度音畫同步（Sentence-level Sync）**：朗讀語音與畫面段落句子毫秒級高亮同步，自動平滑居中滾動（Auto-scroll）。
* **雙引擎 TTS 設計**：預設採用零成本 Web Speech API，並保留雲端高品質類真人語音介面。
* **離線與行動端體驗**：支援 IndexedDB 本機書籍與進度儲存、Media Session 背景/耳機控制與 Wake Lock 防休眠。

---

## 2. 系統架構與技術棧 (System Architecture & Tech Stack)

### 2.1 整體技術棧
| 層級 | 技術選型 | 責任與說明 |
| :--- | :--- | :--- |
| **前端應用 (Web)** | Vue 3 + Nuxt 3 (SSR/SPA 混合) + TypeScript | 響應式介面、型別安全、模組化狀態驅動 |
| **狀態管理** | Pinia + Pinia Plugin Persistedstate | 播放狀態機、章節佇列、使用者偏好設定 |
| **前端電子書解析** | `epub.js` / `@epubjs-ts`, `pdfjs-dist` | 客戶端解析標準 EPUB、PDF 目錄與結構文字 |
| **語音引擎 (TTS)** | Web Speech API (原生) + 雲端語音擴充介面 | 採策略模式（Strategy Pattern）封裝 |
| **本機資料快取** | IndexedDB (`Dexie.js`) | 儲存解密後的電子書二進位檔與閱讀歷程 |
| **樣式與主題** | Tailwind CSS + `@tailwindcss/typography` | 排版最佳化、多主題切換（明亮、深色、羊皮紙） |
| **後端中繼 (ACSM Service)** | Python 3.11 + FastAPI + Docker | 處理 ACSM 解析、Adobe 履約交握、DRM 解密 |
| **DRM 核心工具鏈** | `libgourou` (C++ / Python 綁定) + `NoDRM/DeDRM` | Adobe Content Server 協定實作與 Adept DRM 解密 |

### 2.2 系統架構圖 (Architecture Diagram)

```
[ 用戶瀏覽器 (Frontend) ]
  │
  ├─ (1) 標準檔案 (.epub / .pdf / .txt) ──> [ 前端客戶端解析引擎 (Parser Service) ]
  │                                                   │
  └─ (2) 憑證檔案 (.acsm)                            │
            │                                         │
            ▼ (HTTP POST /api/v1/acsm/fulfill)        │
  [ 後端服務 (ACSM Conversion Backend) ]              │
      ├── XML 詮釋資料解析 (Metadata Extractor)       │
      ├── Adobe 通訊交握模組 (libgourou Core)         │
      │     └── 與 Adobe Content Server 握手兌換      │
      │     └── 下載加密 EPUB / PDF 原檔             │
      ├── DRM 解密引擎 (Adept Decryptor)              │
      │     └── 透過本機匿名授權/Device Key 解密      │
      └── 回傳解密後的標準 EPUB/PDF 二進位串流         │
            │                                         │
            ▼                                         │
  [ 前端虛擬書庫 (IndexedDB Storage) ] <──────────────┘
            │
            ▼
  [ 切句與語意分析引擎 (Sentence Tokenizer) ]
            │ (產生 SentenceItem 佇列)
            ▼
  [ 播放控制器與狀態機 (AudioQueue Store / Pinia) ]
            │
     ┌──────┴─────────────────────────────────┐
     ▼                                        ▼
[ 語音合成引擎 (TTS Engine) ]          [ UI 聯動與裝置層 (Interaction) ]
  ├── Web Speech API (單句派發)          ├── 當前句子高亮 (Highlighting)
  └── Cloud Stream TTS (可選)            ├── 自動平滑滾動 (Auto-scroll)
                                         ├── Media Session API (耳機/鎖屏)
                                         └── Screen Wake Lock (防休眠)
```

---

## 3. 功能需求規格 (Functional Requirements)

### 3.1 ACSM 兌換與檔案解析模組 (ACSM Fulfillment & Ingestion)

#### 3.1.1 後端 ACSM 自動履約解密 API
* **端點**：`POST /api/v1/acsm/fulfill`
* **請求格式**：`multipart/form-data`
  * `file`: `.acsm` 檔案
  * `adobe_id`: (選填，未提供則使用後端本機匿名產生之裝置金鑰)
  * `adobe_password`: (選填)
* **後端內部執行流程**：
  1. **解析 Token**：驗證 XML 是否符合 Adobe Adept 規範，提取 `operatorURL`、`resourceItem` 與 Metadata（書名、作者）。
  2. **啟動履約（Fulfillment）**：調用 `libgourou` 的 `acsmdownloader` 模組，攜帶 Device Activation Token 向 Adobe Server 發起請求。
  3. **下載原始檔案**：串流拉取加密的 `.epub` 或 `.pdf`。
  4. **解密 DRM**：提取授權金鑰，調用 Adept 解密演算法解鎖文件內容，輸出標準 EPUB/PDF。
  5. **回應格式**：
     * 回傳 `Content-Type: application/epub+zip` 二進位串流，或在 Header 帶入書籍 Metadata (`X-Book-Title`, `X-Book-Author`)。
* **錯誤處理與代碼**：
  * `400 ERR_ACSM_MALFORMED`: XML 結構損毀或非 ACSM 憑證。
  * `401 ERR_ADOBE_AUTH_FAILED`: Adobe 帳號驗證失敗或需要特定綁定帳號。
  * `410 ERR_TOKEN_EXPIRED`: 憑證已過期，無法向伺服器兌換。
  * `502 ERR_UPSTREAM_TIMEOUT`: Adobe 履約伺服器無回應。

#### 3.1.2 前端檔案匯入分流處理
* **格式嗅探**：
  * 若副檔名為 `.acsm`，前端 UI 顯示「正在連線 Adobe 履約伺服器兌換並解密書籍...」進度條，透過 Axios/Fetch 傳送至後端端點。
  * 若為 `.epub`, `.pdf`, `.txt`, `.md`，直接走純前端本地解析。
* **二進位儲存**：兌換成功後，前端將原始檔案寫入 IndexedDB，避免重複發送請求。

---

### 3.2 切句與結構重組引擎 (Sentence Tokenizer)

1. **分句演算法**：
   * 閱讀器不宜直接朗讀整段（避免 Web Speech 斷流與高亮粒度過大）。
   * 針對中文與英文常見標點實施斷句正則：
     ```regex
     (?<=[。！？；.!?:…
])\s*
     ```
   * 長句保護：若單句長度超過 120 字且無標點，自動依據逗號（`，,`）或空格進行二級拆分。
2. **語意結構映射**：
   * 每個章節解析後映射為結構化陣列，建立雙向關聯（DOM 節點 ID $\leftrightarrow$ 播放句子 ID）：
     ```typescript
     interface SentenceItem {
       id: string            // 格式：`chap_${chapterIndex}_sent_${index}`
       text: string          // 純文字內容（去除特殊控制字符）
       chapterId: string     // 所屬章節 ID
       order: number         // 播放順序
       domSelector?: string  // 對應渲染節點選擇器
     }
     ```

---

### 3.3 播放控制與 TTS 引擎 (Playback & TTS Engine)

1. **播放狀態機設計**：
   * 狀態列表：`IDLE`（閒置）、`LOADING`（加載/切換中）、`PLAYING`（播放中）、`PAUSED`（暫停）。
   * 支援動作：`play()`, `pause()`, `resume()`, `stop()`, `next()`, `prev()`, `seekTo(sentenceId)`。
2. **Web Speech API 長文接力與防斷流機制**：
   * **單句派發（Single-Utterance Dispatch）**：每次僅向瀏覽器發送一句 `SpeechSynthesisUtterance`。
   * **事件接力**：監聽 `onend` 事件；當觸發時，若處於 `PLAYING` 狀態，推進 `currentSentenceIndex` 並調用下一句播放。
   * **防超時機制（Keep-Alive）**：針對部分瀏覽器在長時間朗讀時的 GC Bug，每 10 秒執行一次心跳檢查（若 `speaking` 卻無事件觸發則重置調度）。
3. **播放控制偏好**：
   * **語速（Rate）**：0.5x ~ 2.5x（步進 0.1）。
   * **音調（Pitch）**：0.8 ~ 1.2。
   * **語音切換（Voice Select）**：過濾可用語音，優先選擇符合語言標籤（如 `zh-TW`）之高品質語音。

---

### 3.4 視覺同步與閱讀器介面 (Audio-Visual Sync & UI)

1. **毫秒級句子動態高亮**：
   * 當前播放之 `SentenceItem` 綁定動態 CSS class（如 `.reading-active-sentence`），套用溫和高對比底色（如羊皮紙淡黃或深色模式亮灰）。
2. **平滑自動滾動（Auto-scroll Tracking）**：
   * 句子切換時，自動調用：
     ```typescript
     element.scrollIntoView({ behavior: 'smooth', block: 'center' })
     ```
   * **使用者操作避讓（Scroll Lockout）**：當偵測到使用者手動滾動螢幕時，暫停自動滾動 4 秒，避免畫面與使用者搶奪焦點。
3. **隨點即讀（Click-to-Speech）**：
   * 內文中的每個句子節點均支援點擊事件，點擊後立刻中斷當前語音，從該句開始朗讀。
4. **排版設定面板**：
   * 字體（襯線體、無襯線體、楷體）。
   * 字級（14px ~ 28px）、行距（1.5 ~ 2.2）、邊距調整。
   * 主題切換：明亮（Light）、護眼（Sepia）、深色（Dark）。

---

### 3.5 系統硬體整合與行動端體驗 (Hardware Integration)

1. **Media Session API**：
   * 註冊標準音訊控制器，使螢幕鎖定畫面、動態島或藍牙耳機線控可顯示：
     * `title`: 書籍名稱
     * `artist`: 作者名稱
     * `album`: 當前章節名稱
   * 綁定 Handlers: `play`, `pause`, `previoustrack`（上一句/上章節）, `nexttrack`（下一句/下章節）。
2. **Screen Wake Lock API**：
   * 播放狀態進入 `PLAYING` 時呼叫 `navigator.wakeLock.request('screen')` 防止螢幕自動關閉。
   * 進入 `PAUSED` 或 `IDLE` 時立即釋放鎖定。

---

## 4. 資料模型與介面定義 (Data Models & TypeScript Interfaces)

```typescript
// types/reader.ts

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

---

## 5. 後端 Docker 部署與環境規劃 (Backend Deployment)

### 5.1 Dockerfile 建議配置
```dockerfile
FROM python:3.11-slim

# 安裝編譯 libgourou 與 openssl 所需工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    cmake \
    pkg-config \
    libssl-dev \
    libcurl4-openssl-dev \
    libzip-dev \
    && rm -rf /var/lib/apt/lists/*

# 下載並編譯安裝 libgourou
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

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## 6. 專案開發里程碑 (Milestones & Roadmap)

| 階段 | 週期 | 交付成果 (Deliverables) |
| :--- | :--- | :--- |
| **Phase 1: 後端 ACSM 解密服務** | 1 週 | 建立 FastAPI 專案，包裝 `libgourou` 容器化服務，完成 `.acsm` 兌換與解密測試 API。 |
| **Phase 2: 前端核心播放與同步** | 1 週 | 實作 `useSpeechReader` 與分句器，完成「單句朗讀 + 自動接力 + 動態高亮 + 平滑滾動」。 |
| **Phase 3: 本地解析與書庫管理** | 1.5 週 | 整合 `epub.js` 與 IndexedDB，完成本機書庫、章節目錄提取、全域閱讀進度恢復。 |
| **Phase 4: 行動端與體驗最佳化** | 1 週 | 整合 Media Session API、Wake Lock API、鎖屏控制與閱讀排版面板（字級/主題）。 |
