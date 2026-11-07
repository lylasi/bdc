# Kokoro 本地 Docker 與 Cloudflare 部署評估

- 核對日期：2026-10-28。
- 問題：Kokoro 需要甚麼環境；可否部署於 Cloudflare，或使用本地 Docker。
- 延續調研：[免費 TTS 模型替代方案調研](20261028113601427_免費TTS模型替代方案調研.md)。
- 本次範圍：官方／上游文件核對、本機資源唯讀檢查、遠端 Docker 映像 manifest 檢查。沒有拉取或執行映像、沒有啟動容器、沒有建立 Tunnel 或修改 BDC 設定，亦未量測實際合成速度及記憶體用量。

## 一、建議

**先用現有 Apple Silicon 電腦的 Docker CPU 版試 Kokoro；需要讓外部手機或線上 BDC 存取時，再以 Cloudflare Tunnel 提供 HTTPS 入口。**

Kokoro 是 82M 的小型 TTS 模型，不需要先購買 GPU。現有硬件具備合理的試驗條件，但「足夠試驗」不等於已驗證指定併發數、文章長度或首段延遲。

Cloudflare 需要按產品區分：一般 Workers／Pages 不適合直接執行完整 Kokoro 推理；Workers AI 的目前官方模型目錄沒有 Kokoro；付費 Containers 則原則上可運行其 CPU Docker 映像。Tunnel 只負責網路轉發，推理仍在本地電腦執行。

## 二、本機環境已核對的事實

| 項目 | 唯讀檢查結果 |
| --- | --- |
| 作業系統／架構 | macOS／Apple Silicon arm64 |
| 主機記憶體 | 38,654,705,664 bytes，即 36 GiB |
| 主機邏輯 CPU | 14 |
| Docker CLI | 已安裝 |
| Docker daemon | 已啟動，Linux aarch64 |
| Docker 可見資源 | 14 CPU、16,818,978,816 bytes 記憶體，約 15.66 GiB |
| `cloudflared` | 本機 PATH 尚未找到 |

上游 CPU 映像 `ghcr.io/remsky/kokoro-fastapi-cpu:latest` 的遠端 manifest 同時列出：

- `linux/amd64`
- `linux/arm64`

因此這台 Apple Silicon 電腦可選原生 ARM64 CPU 映像，不必強制 `--platform linux/amd64` 作 x86 模擬。**此 CPU 容器不使用 Apple GPU／Metal**；如要使用 Apple Silicon GPU，需另評估上游原生執行路徑，與 Docker CPU 方案分開測試。

本次 manifest 的 multi-architecture digest 為：

```text
sha256:ee3111d6a2c903ed62f3b4fa19543c6901205ed39fce3c177e895b34a8386b9c
```

ARM64 對應映像的壓縮 layer 總計 1,426,224,522 bytes，約 1.33 GiB。這是 manifest 中 layer size 的總和，並非已拉取的實際網路用量或解壓後磁碟大小。完整服務不只是約 92 MB 的量化模型檔案，還有 Python、推理引擎、字音轉換及模型資源。

## 三、本地 Docker 的環境要求

### 必要條件

- 可用的 Docker Engine 或 Docker Desktop，能執行 Linux 容器。
- ARM64 或 AMD64 CPU；上游 CPU 映像均提供。
- 初次拉取映像可連線至 GitHub Container Registry。
- 足夠的 Docker 磁碟空間。建議先預留 5–10 GB 作映像、解壓、快取及更新的試驗空間；這是操作預算，不是上游聲稱的最低需求。
- 不需要在 macOS 主機另外安裝 Python、PyTorch 或 CUDA；CPU 映像已包含其推理環境及預建模型。

### 建議試驗資源

個人使用可先以 **2–4 vCPU、4–8 GiB RAM** 作容器資源預算，從單一合成工作開始觀察。上游 README 沒有公布可保證的最低 CPU／RAM，所以上述數字不能當作測得的最低要求或即時合成保證。

這台電腦目前的 Docker 配額高於這個試驗預算，環境上適合開始。若之後改為低功耗 NAS、舊電腦或多人使用，仍須量測首段延遲、後續句子間隔與併發峰值。

NVIDIA GPU 屬可選加速路徑；Linux GPU 部署需匹配驅動及 NVIDIA Container Toolkit。不能因上游效能測試使用 16 GB VRAM，就把 16 GB 當作 Kokoro 最低顯示記憶體要求。

### 最小啟動範例（本次未執行）

```bash
docker run -d \
  --name bdc-kokoro \
  --restart unless-stopped \
  -p 127.0.0.1:8880:8880 \
  ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

上例只把服務映射到主機 loopback，適合先在本機驗證。容器內仍使用上游預設的監聽地址，沒有要求額外設定模型路徑。

啟動及就緒後可查看：

- 試聽介面：`http://127.0.0.1:8880/web`
- API 文件：`http://127.0.0.1:8880/docs`
- 聲線：`http://127.0.0.1:8880/v1/audio/voices`

若要保留此次核對的精確版本，可將映像名稱的 `:latest` 改為前述 `@sha256:...` digest。`latest` 會隨上游更新。

### 合成請求範例（本次未執行）

```bash
curl --fail-with-body \
  http://127.0.0.1:8880/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","input":"The weather is lovely today.","voice":"bf_emma","speed":1.0,"response_format":"mp3"}' \
  --output kokoro-sample.mp3
```

`bf_emma` 為英式音色；美式可先比較 `af_heart`。上游路徑為 `POST /v1/audio/speech`，不是 BDC 現在使用的 GET `/tts`。

## 四、Cloudflare 各種方式是否可行

| 產品／方式 | 對 Kokoro 的適用性 | 成本與限制 |
| --- | --- | --- |
| Pages 靜態託管 | 可以提供前端及瀏覽器推理資源；不會替使用者執行 Python／Docker 推理 | 若模型在瀏覽器執行，下載、RAM 與 CPU／GPU 負擔落在手機／電腦；不是 Cloudflare 代跑模型 |
| 一般 Workers | 不建議直接載入完整 Kokoro 推理 | Worker 記憶體上限 128 MB，還有 CPU／啟動限制；即使模型檔案可下載，也不代表模型、推理引擎、activation 能放入記憶體 |
| Workers AI | 本次官方模型目錄沒有 Kokoro | 有 MeloTTS、Deepgram Aura 等其他 TTS；若接受換模型可另測，不能當作已提供 Kokoro |
| Containers | **原則可行，需實際部署驗證** | 支援 Linux AMD64 的容器，有 CPU 資源；需 Workers Paid，不是永久免費 Docker 託管 |
| Tunnel 接本地 Docker | **目前最建議** | Kokoro 留在本地運行，Cloudflare 提供外部連線；電腦、Docker 及 connector 要持續運行 |

### 4.1 一般 Workers 的角色

Workers 可作認證、配額、轉接、快取及請求路由；不應把它與有數 GiB RAM 的推理容器混為一談。R2 也只提供儲存，並不提供模型運算。

### 4.2 Workers AI 的免費 TTS 是另一條選型

本次目錄列出 `@cf/myshell-ai/melotts` 及 Deepgram Aura 系列，沒有 Kokoro。官方定價頁有每日 10,000 Neurons 免費配額；不同模型消耗不同，不能直接寫成「所有 TTS 都免費無限用」。若最重視不開本地電腦，可另行比較其英語口音、單字表現及免費量，而不是稱作 Kokoro 的 Cloudflare 部署。

### 4.3 Containers 的資源與費用

官方列出的預設配置包括：

| 配置 | vCPU | RAM | 磁碟 |
| --- | ---: | ---: | ---: |
| standard-1 | 0.5 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Cloudflare 要求映像為 `linux/amd64`；本次查核的 Kokoro CPU 映像有該平台版本。這只是架構相容性，未證明合成速度、冷啟動及整合均通過。

Containers 需要 **Workers Paid，每月 US$5 基本費**。包含的容器月用量為 25 GiB-hours RAM、375 vCPU-minutes、200 GB-hours 磁碟，超出後另計。官方單價為：

- RAM：US$0.0000025／GiB-second。
- CPU：US$0.000020／active vCPU-second。
- 磁碟：US$0.00000007／GB-second。

**示例而非報價：**若一個 standard-2（6 GiB RAM／12 GB 磁碟）持續運行 30 天，扣除上述整份免費用量，單是 RAM 與磁碟約 US$40.78，加 US$5 基本費約 **US$45.78**；還未計 active CPU、Worker／Durable Object、網路及其他服務用量。例子假設沒有其他容器分享月額度。休眠可降低成本，所以實際按需使用未必達到此數字，但不宜理解為每月只需 US$5。

容器停止或休眠後會重新經歷服務啟動及模型載入；官方平台的一般冷啟動描述不是 Kokoro 的就緒時間保證。容器本地磁碟在重新建立時不保留執行期變更，模型應打包進映像或設計可重建的下載流程；持久音訊快取亦應另存。

## 五、本地 Docker 加 Tunnel 的實際分工

建議請求流程：

```text
手機／電腦的 BDC（HTTPS）
    → Cloudflare 上的 HTTPS 路由及 BDC 認證／TTS 協議轉接
    → Tunnel 可到達的 Kokoro origin
    → 本地 Docker Kokoro CPU（內部 HTTP 8880）
```

Tunnel 的 `cloudflared` 從本地主動向 Cloudflare 連線，不需把家中 8880 直接向公網開放，也不需要固定公網 IP。Cloudflare 提供公開 HTTPS 入口；本地回源可以是 HTTP。

實作時需區分 connector 跑在哪裡：

- **`cloudflared` 跑在 macOS 主機**：可回源到上例 `http://127.0.0.1:8880`。
- **`cloudflared` 也跑在 Docker**：建議與 Kokoro 放在同一個 Docker network，以服務名稱回源，例如 `http://kokoro:8880`。connector 容器的 `localhost` 是 connector 自己，不能當作 macOS 或另一個容器。
- 同網段直接由手機連線時，要改為可達的主機 LAN 位址及適當 port binding；上例的 loopback 映射刻意不開放 LAN。線上 HTTPS BDC 直連 HTTP LAN 還涉及混合內容及本地網路權限，Tunnel 可避開這條直連路徑。

固定網域可配置 published application route。公開路由前應加入與 BDC 相容的認證和限流，不能把未保護的合成服務當作公開無限制 API。Access 的瀏覽器登入、預檢及跨域行為也要按實際 BDC 調用路徑驗證；如果有服務 token，應留在服務端，不能寫進靜態前端。

電腦休眠、關機、Docker 停止或網路斷線時，外部便無法完成新的本地合成。這是本地部署的可用性條件；Cloudflare Tunnel 不會接手模型運算。

## 六、與 BDC 的接入工作

現有協議大致是：

```text
GET /tts?t=<text>&v=<voice>&r=<rate>
GET /voices
```

Kokoro-FastAPI 提供：

```text
POST /v1/audio/speech
GET /v1/audio/voices
```

因此除了啟動 Docker，還需共用音訊適配或服務端轉接，涵蓋：

1. 文字／聲線／語速參數轉換。
2. `af_heart`、`bf_emma` 等聲線 ID 與 BDC 現有英美口音設定的映射。
3. 聲線列表來源；不能繼續優先展示不受 Kokoro 支援的靜態微軟聲線。
4. 音訊回傳、取消、完成回調及故障回退；聽寫進度依靠完成回調。
5. 獨立拼讀頁、下載、長文分塊及下一句預取。
6. 公開服務認證、CORS，以及兩種 UI 語言的完整互動驗證。

Kokoro 官方仍提醒短輸入可能較弱。第一次驗證應同時比較英語單字、例句和文章，再決定是否只用於文章朗讀。

## 七、參考來源

- [Kokoro-FastAPI README](https://github.com/remsky/Kokoro-FastAPI)。
- [上游 CPU Dockerfile](https://github.com/remsky/Kokoro-FastAPI/blob/master/docker/cpu/Dockerfile.optimized)。
- [上游 CPU Compose](https://github.com/remsky/Kokoro-FastAPI/blob/master/docker/cpu/docker-compose.yml)。
- [上游設定文件](https://github.com/remsky/Kokoro-FastAPI/blob/master/docs/configuration.md)。
- Docker Registry 遠端 manifest：`ghcr.io/remsky/kokoro-fastapi-cpu:latest`，以 `docker buildx imagetools inspect` 唯讀核對平台及 digest，沒有 pull／run。
- [Workers 執行限制](https://developers.cloudflare.com/workers/platform/limits/)。
- [Workers AI 模型目錄](https://developers.cloudflare.com/workers-ai/models/)。
- [Workers AI 價格及免費配額](https://developers.cloudflare.com/workers-ai/platform/pricing/)。
- [Containers 起步及 AMD64 要求](https://developers.cloudflare.com/containers/get-started/)。
- [Container 生命週期](https://developers.cloudflare.com/containers/concepts/architecture/)。
- [Containers 資源限制](https://developers.cloudflare.com/containers/platform/limits/)。
- [Containers 定價](https://developers.cloudflare.com/containers/pricing/)。
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)。
- [Tunnel published application 設定](https://developers.cloudflare.com/tunnel/get-started/)。

使用者提及的 `@grill-me` 沒有出現在本次可用工具或代理名單中；本調研沒有將其當作已知部署主機，亦沒有向其他使用者或會話發送訊息。
