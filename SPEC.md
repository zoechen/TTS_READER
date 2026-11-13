# Web 語音朗讀閱讀器（Web Audio Reader）系統規格文件 (PRD & Tech Spec)

**版本**：v1.3.0  
**日期**：2026-11-12  
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
  * `502 ERR_UPSTREAM_TIMEOUT`: Adobe 履約伺服器無回應；**其餘未分類的履約失敗也會落到此碼**（例如授權已被其他 Adobe 身分兌換，訊息內含 `E_LIC_ALREADY_FULFILLED_BY_ANOTHER_USER`），客戶端應直接顯示訊息內文。
  * `503 ERR_ACTIVATION_PENDING`: 後端仍在向 Adobe 註冊裝置身分，請稍後重試。
  * `503 ERR_ACTIVATION_FAILED`: 裝置身分註冊重試用盡仍失敗，需重啟後端。

#### 3.1.1a Adobe 裝置身分（Device Activation）
* **授權綁定規則**：Adobe 授權綁定於「購買」而非 `.acsm` 檔案本身，由**第一個兌換成功的 Adobe 身分**取得。同一身分可重複兌換同一本書；換了身分（例如容器重建後重新匿名註冊）則會被 Adobe 回應 `E_LIC_ALREADY_FULFILLED_BY_ANOTHER_USER`。重新下載 `.acsm` 不會重設綁定。本系統不提供、也不應實作繞過此綁定的機制；需重設綁定時請洽電子書平台客服。
* **身分持久化**：`adept_activate` 將 `activation.xml`、`device.xml`、`devicesalt` 寫入 `~/.config/adept/`。此目錄**必須掛載為持久 volume**（`/root/.config/adept`），否則容器重建即遺失身分。
* **啟動註冊**：僅在 `activation.xml` 不存在時註冊，於**背景執行緒**進行，API 與 `/health` 不受阻塞；每次嘗試逾時 45 秒，最多重試 5 次（間隔 5 秒）。
* **已知陷阱**：`adept_activate` 偵測到目錄已存在時會互動詢問「覆蓋？[y/N]」，無回應時會無限重複輸出提示。後端以 stdin 自動回答 `y`（僅在確認無 `activation.xml` 時才執行，不會覆蓋既有身分），且所有外部工具輸出皆寫入大小受限的暫存檔（`RLIMIT_FSIZE`，僅保留尾端），避免失控輸出耗盡記憶體。
* **狀態查詢**：`GET /api/v1/acsm/status` → `{"activation": "unknown|pending|ok|failed|unavailable"}`。

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
2. **段落保留**：
   * `SentenceItem.paraStart` 標記該句是否為段落第一句；閱讀畫面依此分段換行，段首縮排兩字。
   * 分段規則：文字含空行（`\n\s*\n`）則以空行分段，否則以單一換行分段。
   * **EPUB**：以走訪 DOM 區塊元素（`p, div, li, h1–h6, blockquote, section, article, tr, pre, dt, dd, figcaption`）取代 `innerText`（未渲染文件的 `innerText` 不含區塊換行），區塊間補 `\n\n`，`<br>` 補 `\n`。
   * **PDF**：保留每行座標（x、結尾 x、y、字級），以 `linesToParagraphs` 判斷換段：行距大於該頁中位數行距約 1.45 倍、前一行句子已結束且本行首行縮排（約 1.2 字寬以上）、前一行句子已結束且為明顯短尾行、版面換欄。換頁時若上一頁結尾無結束標點，視為同一段延續到下一頁。
3. **語意結構映射**：
   * 每個章節解析後映射為結構化陣列，建立雙向關聯（DOM 節點 ID $\leftrightarrow$ 播放句子 ID）：
     ```typescript
     interface SentenceItem {
       id: string            // 格式：`chap_${chapterIndex}_sent_${index}`
       text: string          // 純文字內容（去除特殊控制字符）
       chapterId: string     // 所屬章節 ID
       order: number         // 播放順序
       paraStart?: boolean   // 是否為段落第一句
       domSelector?: string  // 對應渲染節點選擇器
     }
     ```

---

### 3.3 播放控制與 TTS 引擎 (Playback & TTS Engine)

1. **播放狀態機設計**：
   * 狀態列表：`IDLE`（閒置）、`LOADING`（加載/切換中）、`PLAYING`（播放中）、`PAUSED`（暫停）。
   * 支援動作：`play()`, `pause()`, `resume()`, `stop()`, `next()`, `prev()`, `seekTo(sentenceId)`。
   * **章節切換**：使用者手動切換章節（章節選單、上一章／下一章按鈕）會**立即停止**目前朗讀並回到 `IDLE`，新章節從第一句待命，需再按播放；朗讀到章節結尾時的自動接續下一章不受影響。
2. **Web Speech API 長文接力與防斷流機制**：
   * **單句派發（Single-Utterance Dispatch）**：每次僅向瀏覽器發送一句 `SpeechSynthesisUtterance`。
   * **事件接力**：監聽 `onend` 事件；當觸發時，若處於 `PLAYING` 狀態，推進 `currentSentenceIndex` 並調用下一句播放。
   * **防超時機制（Keep-Alive）**：針對部分瀏覽器在長時間朗讀時的 GC Bug，每 10 秒執行一次心跳檢查（若 `speaking` 卻無事件觸發則重置調度）。
3. **語音引擎（Strategy）**：`TTSEngine` 介面（`speak / cancel / isActive / prefetch`），目前有兩種實作：
   * `webspeech`：瀏覽器內建 Web Speech API。
   * `cloud`：呼叫後端 `POST /api/v1/tts`（或使用者自訂端點），播放回傳的音訊；提前預取下一句，並以「語音 + 速度 + 音調 + 文字」為快取鍵。
4. **後端 TTS 代理**（`POST /api/v1/tts`，`GET /api/v1/tts/config`）：
   * 請求：`{ text, voice?, rate (0.25–4, 1=正常), pitch (-50–50, 百分比, 0=不變) }`；`text` 上限 1000 字（`413 ERR_TTS_TEXT_TOO_LONG`）。
   * `TTS_PROVIDER=edge`（預設）：使用 `edge-tts` 的 Microsoft Edge 神經語音，免費、免 API Key。`rate` 轉成 `±N%`，`pitch` 轉成 `±NHz`（約 2 Hz／1%）。預設語音 `zh-TW-HsiaoChenNeural`。服務偶發回傳空音訊，後端自動重試 3 次，仍失敗回 `502 ERR_TTS_UPSTREAM`；參數錯誤回 `400 ERR_TTS_BAD_PARAMS`。
   * `TTS_PROVIDER=http`：以 `TTS_BODY_TEMPLATE`（支援 `{{text}} {{voice}} {{rate}} {{pitch}}`）轉發至 `TTS_UPSTREAM_URL`，金鑰僅存於伺服器環境變數。
   * 純標點／符號的文字（如 `……`、`「」`、`———`）沒有可朗讀內容，Edge 會回傳空音訊；後端對 `edge` 模式直接回 `400 ERR_TTS_NO_SPEECH`（不重試），前端播放時則**直接跳過**這類句子（`isSpeakable`：需含至少一個字母或數字）。
   * `/api/v1/tts/config` 回傳 `{ enabled, provider }`；provider 為 `edge` 時，前端將 `audio.playbackRate` 固定為 1（速度與音調由伺服器合成時套用）。
   * **風險**：`edge-tts` 使用非官方端點，無服務保證，可能被限流或失效；失敗時介面顯示錯誤，使用者可切回 Web Speech。男聲 `zh-TW-YunJheNeural` 於 2026-11-12 測試持續失敗，預設男聲改用 `zh-CN-YunxiNeural`。
5. **情感語調（Prosody）**：`analyzeProsody(text, { nextIsParaStart })` 依句子內容回傳 `{ rateMul, pitchPct, pauseAfterMs }`，由設定項 `expressive`（預設開啟）控制，兩種引擎皆適用：

   | 條件 | 調整 |
   | :--- | :--- |
   | 結尾為 `？/?`（忽略結尾引號） | 音調 +8%、速度 ×0.97、停頓 400ms |
   | 結尾為 `！/!` | 音調 +6%、速度 ×1.06、停頓 400ms |
   | 結尾為 `…`、`...`、`——` | 速度 ×0.92、停頓 600ms |
   | 整句位於 `「」『』“”` 內（對話） | 音調 +5%、速度 ×1.03 |
   | 一般句號結尾 | 停頓 350ms |
   | 逗號等子句結尾 | 停頓 180ms |
   | 段落最後一句 | 停頓至少 700ms |

   速度乘數限制在 0.8–1.2、音調限制在 ±15%。句間停頓以計時器實作，`pause / stop / seek / 換句` 時必須清除，避免殘留計時造成重複朗讀。預取下一句時使用該句自己的語氣參數以維持快取命中。
6. **發音修正字典（破音字）**：
   * 設定項 `pronunciationRules`：每行一條 `原文=讀成`（亦接受 `＝`、`→`、`=>`），`#` 開頭為註解，空白行忽略；`讀成` 可為空（朗讀時略過該原文）。
   * `applyPronunciations(text, rules)`（`utils/pronounce.ts`）：朗讀前將原文換成較容易讀對的同音字或寫法；**最長詞優先**、單趟掃描且不重複替換（規則不會連鎖套用）、規則以字面比對而非正規表達式。畫面顯示的文字、情感語調分析與純標點判斷皆使用原文，只有送進 TTS 引擎與預取的文字會被替換。
   * **內建字典**（`utils/defaultPronunciations.ts`，設定項 `builtinPronunciations`，預設開啟）：與使用者規則同格式，使用者規則在等長比對時優先（要停用某條，寫 `詞=詞` 即可）。目前收錄「行」：
     * háng：銀行、行業、行列、外行、內行、行家、排行、行情、行距、行號、商行、行話、各行各業、分行、總行、行員、改行、轉行… 以同音字「航」替換。
     * xìng：品行、德行、孝行、罪行、惡行、善行、言行 → 以「幸」替換（依教育部辭典；口語常讀 xíng 者可自行用 `詞=詞` 關閉）。
     * **保護規則**（`詞=詞`）：進行、執行、旅行、行為、行走… 等 xíng 詞會先被吃掉，避免 `進行業務` 被內部的「行業」誤換成「進航業務」。
     * **長**（zhǎng，以「掌」替換）：校長、市長、家長、班長、成長、生長、增長、長輩、長官、長大、長相… 等約 75 詞；cháng 的詞（擅長、專長、漫長、長期、長度…）與易誤傷的組合（專家長期、大家、社會…）以保護規則先吃掉。
     * **了**（liǎo，以「瞭」替換）：了解、了不起、了不得、受不了、吃不了、一了百了、不了了之、一目了然、直截了當… 等約 26 詞；單獨的助詞「了」（le）不處理，`了解釋`、`了然後` 等 le＋詞的組合以保護規則排除。
     * 為避免誤傷助詞「了」，`了結`、`了斷`、`了事`、`了卻`、`了無`、`了債`、`了局`、`了得`、`明了`、`終了` 等短詞刻意不收（例如「看了卻沒…」「說明了問題」）。
     * 只收辭典讀音明確的詞；`同行`、`發行`、`暴行`、`行頭`、`行次`、`行使` 等有多讀法者不處理。讀音資料由萌典 API 查證，專案不內建其資料。
   * **內建清理**：`cleanForSpeech` 將 `/ ／ \\ ＼`（含前後空白）換成短停頓「，」，避免被念成「斜線」；在使用者規則之後執行，因此規則（如 `w/o=without`）可覆寫。
   * 受限於 `edge-tts` 會將文字完整 XML 跳脫、無法插入 SSML `<phoneme>`，故以「替換同音字」處理；兩種引擎（Web Speech、Edge）皆適用。
   * 查詢讀音可參考教育部《重編國語辭典修訂本》線上版萌典（https://www.moedict.tw/ ，API 例：`/raw/長` 回傳各讀音 `bopomofo`）。該辭典文字為教育部著作，公開授權為 CC BY-ND 台灣 3.0，故不內建、不重製其資料，只提供連結。
7. **播放控制偏好**：
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
   * 字體（襯線體、無襯線體、楷體），按鈕式分段選擇。
   * 字級（14px ~ 28px）、行距（1.5 ~ 2.2）。
   * 邊距（`pageWidth`）：窄邊距（內文寬 60rem）、標準（46rem）、寬邊距（36rem）。
   * 主題切換：明亮（Light）、護眼（Sepia）、深色（Dark），以色票按鈕呈現並即時預覽。
   * 情感語調開關、語速、音調、語音選擇；點擊面板外部即關閉。
5. **版面與主題**：
   * 所有顏色以 CSS 變數（`--bg --fg --muted --border --surface --bar --accent --hl`）定義於 `main.css`，依 `data-theme` 切換；頂部列、底部控制列、設定面板與高亮句皆跟隨主題。
   * 頂部列：返回書庫、書名、章節選單、百分比，下方為閱讀進度條。
   * 底部控制列：上一章、上一句、播放／暫停（圓形主按鈕）、下一句、下一章、設定（Aa）；半透明模糊背景。
   * 章節標題置中；內文以段落呈現（段首縮排、段間距），中文斷行最佳化。

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
  paraStart?: boolean   // 段落第一句
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

export interface CloudSettings {
  useProxy: boolean          // true: 走後端 /api/v1/tts 代理（金鑰存於伺服器）
  endpoint: string
  apiKey: string
  voice: string
  voiceFemale: string        // 預設 zh-TW-HsiaoChenNeural
  voiceMale: string          // 預設 zh-CN-YunxiNeural
  bodyTemplate: string       // 支援 {{text}} {{voice}} {{rate}} {{pitch}}
  extraHeaders: string
}

export interface ReaderSettings {
  ttsEngine: 'webspeech' | 'cloud'
  cloud: CloudSettings
  ttsRate: number
  ttsPitch: number
  voiceMap: Record<'any' | 'female' | 'male', string>   // Web Speech 各性別對應語音
  voiceGender: 'any' | 'female' | 'male'
  theme: 'light' | 'sepia' | 'dark'
  fontSize: number
  lineHeight: number
  fontFamily: 'sans' | 'serif' | 'kai'
  autoScroll: boolean
  expressive: boolean                                    // 情感語調
  pageWidth: 'narrow' | 'normal' | 'wide'               // 內文寬度（邊距）
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

### 5.2 環境變數與 Volume

| 變數 | 預設 | 說明 |
| :--- | :--- | :--- |
| `TTS_PROVIDER` | `edge` | `edge`：Edge 神經語音；`http`：轉發至 `TTS_UPSTREAM_URL` |
| `TTS_UPSTREAM_URL` / `TTS_API_KEY` | 空 | `http` 模式的上游端點與金鑰（僅存伺服器） |
| `TTS_DEFAULT_VOICE` | 空 | 請求未指定語音時使用（edge 預設 `zh-TW-HsiaoChenNeural`） |
| `TTS_BODY_TEMPLATE` / `TTS_EXTRA_HEADERS` | 見 `docker-compose.yml` | `http` 模式的請求內容與額外標頭 |

* **Volume**：`adobe-config` 必須掛載到 `/root/.config/adept`（Adobe 裝置身分，見 3.1.1a）。
* **前端**：`runtimeConfig.public.acsmApiBase` 為後端網址（預設 `http://localhost:8000`），可用環境變數 `NUXT_PUBLIC_ACSM_API_BASE` 覆寫；區網手機測試時需改為電腦的區網 IP 並以 `nuxt dev --host` 啟動（Wake Lock 在非 HTTPS 下無法使用）。

---

## 6. 專案開發里程碑 (Milestones & Roadmap)

| 階段 | 週期 | 交付成果 (Deliverables) |
| :--- | :--- | :--- |
| **Phase 1: 後端 ACSM 解密服務** | 1 週 | 建立 FastAPI 專案，包裝 `libgourou` 容器化服務，完成 `.acsm` 兌換與解密測試 API。 |
| **Phase 2: 前端核心播放與同步** | 1 週 | 實作 `useSpeechReader` 與分句器，完成「單句朗讀 + 自動接力 + 動態高亮 + 平滑滾動」。 |
| **Phase 3: 本地解析與書庫管理** | 1.5 週 | 整合 `epub.js` 與 IndexedDB，完成本機書庫、章節目錄提取、全域閱讀進度恢復。 |
| **Phase 4: 行動端與體驗最佳化** | 1 週 | 整合 Media Session API、Wake Lock API、鎖屏控制與閱讀排版面板（字級/主題）。 |
| **Phase 5: 閱讀體驗與情感語調** | 1 週 | 介面主題化與排版優化、EPUB／PDF 段落保留、Edge 神經語音代理、情感語調（語氣與停頓）、Adobe 裝置身分持久化與背景註冊。 |
