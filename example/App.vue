<script setup lang="ts">
import type { Chunk, ProcessController } from '../src'
import { computed, onUnmounted, reactive, ref } from 'vue'
import { calculateFileHash, CancellationError, chunkFile, processChunks, RetryExhaustedError } from '../src'

type ChunkStatus = 'hashing' | 'hashed' | 'processing' | 'retrying' | 'completed' | 'failed' | 'cancelled'

interface ChunkState {
  index: number
  status: ChunkStatus
  hash: string
  size: number
  attempts: number
}

type Phase = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

interface LogEntry {
  id: number
  ts: string
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
}

const file = ref<File | null>(null)
const isDragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const showLogs = ref(true)

const chunkSizeMB = ref(2)
const concurrency = ref(4)
const maxRetries = ref(3)
const retryBaseDelay = ref(400)
const failureRate = ref(0.25)
const minLatency = ref(300)
const maxLatency = ref(1200)

const chunkSizeOptions = [0.5, 1, 2, 4, 8, 16]
const concurrencyOptions = [1, 2, 4, 6, 8, 12]

const phase = ref<Phase>('idle')
const chunkStates = ref<ChunkState[]>([])
const fileHash = ref('')
const isHashing = ref(false)

const stats = reactive({
  startedAt: 0,
  finishedAt: 0,
  totalAttempts: 0,
  retryAttempts: 0,
  failed: 0,
  bytesDone: 0,
})

const logs = ref<LogEntry[]>([])
let logCounter = 0

let chunkPromises: Promise<Chunk>[] = []
let controller: ProcessController | null = null

const totalChunks = computed(() => chunkStates.value.length)
const completedChunks = computed(() => chunkStates.value.filter(c => c.status === 'completed').length)
const hashedChunks = computed(() => chunkStates.value.filter(c => c.status !== 'hashing').length)
const activeChunks = computed(() => chunkStates.value.filter(c => c.status === 'processing' || c.status === 'retrying').length)

const progressPct = computed(() => totalChunks.value ? (completedChunks.value / totalChunks.value) * 100 : 0)
const hashPct = computed(() => totalChunks.value ? (hashedChunks.value / totalChunks.value) * 100 : 0)

const elapsedMs = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const throughputMB = computed(() => {
  if (!elapsedMs.value || !stats.bytesDone)
    return 0
  return stats.bytesDone / 1024 / 1024 / (elapsedMs.value / 1000)
})

const isBusy = computed(() => phase.value === 'running' || phase.value === 'paused')
const canStart = computed(() => !!file.value && !isBusy.value)
const canPause = computed(() => phase.value === 'running')
const canResume = computed(() => phase.value === 'paused')
const canCancel = computed(() => isBusy.value)
const canHash = computed(() => !!chunkStates.value.length && !isBusy.value && !isHashing.value)
const canReset = computed(() => phase.value !== 'idle' && !isBusy.value)

const phaseLabel = computed(() => ({
  idle: '待开始',
  running: '处理中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '部分失败',
})[phase.value])

const workerCount = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4

function formatBytes(n: number) {
  if (!n)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

function formatMs(ms: number) {
  if (ms < 1000)
    return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function log(level: LogEntry['level'], message: string) {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  logs.value.unshift({ id: ++logCounter, ts, level, message })
  if (logs.value.length > 250)
    logs.value.length = 250
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function reset() {
  controller?.cancel()
  controller = null
  chunkPromises = []
  chunkStates.value = []
  fileHash.value = ''
  phase.value = 'idle'
  stats.startedAt = 0
  stats.finishedAt = 0
  stats.totalAttempts = 0
  stats.retryAttempts = 0
  stats.failed = 0
  stats.bytesDone = 0
  elapsedMs.value = 0
  stopElapsedTimer()
}

function handleFile(f: File) {
  reset()
  file.value = f
  log('info', `已选择 ${f.name} · ${formatBytes(f.size)}${f.type ? ` · ${f.type}` : ''}`)
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.[0])
    handleFile(input.files[0])
  input.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f)
    handleFile(f)
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancellationError())
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CancellationError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function start() {
  if (!file.value || isBusy.value)
    return

  const f = file.value
  reset()
  file.value = f

  const chunkSize = chunkSizeMB.value * 1024 * 1024
  const total = Math.ceil(f.size / chunkSize) || 0
  if (!total) {
    log('warn', '空文件无法分片')
    return
  }

  phase.value = 'running'
  stats.startedAt = performance.now()
  elapsedTimer = setInterval(() => {
    if (stats.startedAt)
      elapsedMs.value = performance.now() - stats.startedAt
  }, 100)

  chunkStates.value = Array.from({ length: total }, (_, i) => ({
    index: i,
    status: 'hashing',
    hash: '',
    size: Math.min(chunkSize, f.size - i * chunkSize),
    attempts: 0,
  }))

  log('info', `分片 ${total} · 每片 ${formatBytes(chunkSize)} · ${workerCount} 个 Worker 并行哈希 · 并发 ${concurrency.value}`)

  try {
    chunkPromises = chunkFile(f, { chunkSize })
  }
  catch (err) {
    phase.value = 'failed'
    stopElapsedTimer()
    log('error', `创建分片失败：${err instanceof Error ? err.message : String(err)}`)
    return
  }

  chunkPromises.forEach((p, i) => {
    p.then((chunk) => {
      const s = chunkStates.value[i]
      if (s.status === 'hashing') {
        s.status = 'hashed'
        s.hash = chunk.hash
      }
    }).catch((err) => {
      const s = chunkStates.value[i]
      if (s)
        s.status = 'failed'
      log('error', `#${i} 哈希失败：${err instanceof Error ? err.message : String(err)}`)
    })
  })

  const lockedMaxRetries = maxRetries.value
  controller = processChunks(
    chunkPromises,
    async (chunk, signal) => {
      const s = chunkStates.value[chunk.index]
      s.attempts++
      stats.totalAttempts++

      const isRetry = s.attempts > 1
      s.status = isRetry ? 'retrying' : 'processing'
      if (isRetry) {
        stats.retryAttempts++
        log('info', `#${chunk.index} 第 ${s.attempts} 次尝试（指数退避后恢复）`)
      }

      const latency = minLatency.value + Math.random() * Math.max(0, maxLatency.value - minLatency.value)
      await abortableSleep(latency, signal)

      if (Math.random() < failureRate.value) {
        const exhausted = s.attempts > lockedMaxRetries
        if (exhausted) {
          s.status = 'failed'
          stats.failed++
          log('error', `#${chunk.index} 重试耗尽（${s.attempts} 次尝试）`)
        }
        else {
          log('warn', `#${chunk.index} 失败，准备退避重试`)
        }
        throw new Error(`#${chunk.index} simulated failure`)
      }

      s.status = 'completed'
      stats.bytesDone += chunk.blob.size
      log('success', `#${chunk.index} 完成 · ${formatBytes(chunk.blob.size)} · ${chunk.hash.slice(0, 10)}`)
    },
    {
      concurrency: concurrency.value,
      maxRetries: lockedMaxRetries,
      retryBaseDelayMs: retryBaseDelay.value,
    },
  )

  try {
    await controller.promise
    phase.value = stats.failed > 0 ? 'failed' : 'completed'
    stats.finishedAt = performance.now()
    if (stats.failed > 0)
      log('warn', `处理结束：${completedChunks.value}/${total} 成功 · ${stats.failed} 失败 · 耗时 ${formatMs(stats.finishedAt - stats.startedAt)}`)
    else
      log('success', `全部完成 · ${total} 个分片 · 耗时 ${formatMs(stats.finishedAt - stats.startedAt)}`)
  }
  catch (err) {
    stats.finishedAt = performance.now()
    if (err instanceof CancellationError) {
      phase.value = 'cancelled'
      chunkStates.value.forEach((c) => {
        if (c.status === 'hashing' || c.status === 'hashed' || c.status === 'processing' || c.status === 'retrying')
          c.status = 'cancelled'
      })
      log('warn', '任务已取消')
    }
    else if (err instanceof RetryExhaustedError) {
      phase.value = 'failed'
      log('error', `重试耗尽 · 最后一次错误：${(err.cause as Error)?.message ?? String(err.cause)}`)
    }
    else {
      phase.value = 'failed'
      log('error', `处理异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  finally {
    stopElapsedTimer()
    controller = null
  }
}

function pause() {
  if (!controller)
    return
  controller.pause()
  phase.value = 'paused'
  log('info', '已暂停 · 已开始的处理函数会自然结束，新任务等待 resume')
}

function resume() {
  if (!controller)
    return
  controller.resume()
  phase.value = 'running'
  log('info', '已恢复')
}

function cancel() {
  if (!controller)
    return
  controller.cancel()
  log('warn', '请求取消 · AbortSignal 已触发')
}

async function hashFile() {
  if (!chunkPromises.length)
    return
  isHashing.value = true
  log('info', '开始按顺序计算文件 MD5（增量喂入 SparkMD5）...')
  const t0 = performance.now()
  try {
    fileHash.value = await calculateFileHash(chunkPromises)
    log('success', `MD5: ${fileHash.value} · ${formatMs(performance.now() - t0)}`)
  }
  catch (err) {
    log('error', `MD5 计算失败：${err instanceof Error ? err.message : String(err)}`)
  }
  finally {
    isHashing.value = false
  }
}

function clearLogs() {
  logs.value = []
}

onUnmounted(() => {
  controller?.cancel()
  stopElapsedTimer()
})
</script>

<template>
  <div class="app">
    <header class="hero">
      <div class="hero-inner">
        <div class="brand">
          <div class="logo">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
            </svg>
          </div>
          <div>
            <h1>FluxForge</h1>
            <p>基于 Web Worker 的浏览器端文件分片库 · 演示</p>
          </div>
        </div>
        <a class="github" href="https://github.com/joygqz/fluxforge" target="_blank" rel="noopener">
          GitHub
          <span>↗</span>
        </a>
      </div>
      <div class="feature-tags">
        <span><b>{{ workerCount }}×</b> 多 Worker 并行哈希</span>
        <span>可调并发处理</span>
        <span>暂停 · 恢复 · 取消</span>
        <span>指数退避自动重试</span>
        <span>SparkMD5 完整性校验</span>
      </div>
    </header>

    <main class="container">
      <section
        v-if="!file"
        class="drop-zone"
        :class="{ over: isDragOver }"
        @click="fileInput?.click()"
        @dragover.prevent="isDragOver = true"
        @dragleave="isDragOver = false"
        @drop="onDrop"
      >
        <div class="drop-content">
          <div class="drop-icon">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div class="drop-text">
            拖入文件 · 或 <span>点击选择</span>
          </div>
          <div class="drop-hint">
            建议用 100 MB 以上的文件，能更直观地看到并发效果
          </div>
        </div>
        <input ref="fileInput" type="file" hidden @change="onFileChange">
      </section>

      <section v-else class="file-card">
        <div class="file-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div class="file-info">
          <div class="file-name">
            {{ file.name }}
          </div>
          <div class="file-meta">
            {{ formatBytes(file.size) }}{{ file.type ? ` · ${file.type}` : '' }}
          </div>
        </div>
        <button class="ghost" :disabled="isBusy" @click="fileInput?.click()">
          更换文件
        </button>
        <input ref="fileInput" type="file" hidden @change="onFileChange">
      </section>

      <section v-if="file" class="stats-grid">
        <div class="stat">
          <div class="stat-label">
            分片
          </div>
          <div class="stat-value">
            {{ completedChunks }}<span>/ {{ totalChunks || '—' }}</span>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            进行中
          </div>
          <div class="stat-value">
            {{ activeChunks }}<span>/ {{ concurrency }}</span>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            尝试 / 重试
          </div>
          <div class="stat-value">
            {{ stats.totalAttempts }}<span class="muted">重试 {{ stats.retryAttempts }}</span>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            失败分片
          </div>
          <div class="stat-value" :class="{ danger: stats.failed > 0 }">
            {{ stats.failed }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            已处理
          </div>
          <div class="stat-value">
            {{ formatBytes(stats.bytesDone) }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            吞吐
          </div>
          <div class="stat-value">
            {{ throughputMB.toFixed(2) }}<span>MB/s</span>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            耗时
          </div>
          <div class="stat-value">
            {{ formatMs(elapsedMs) }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            状态
          </div>
          <div class="stat-value">
            <span class="phase" :data-phase="phase">{{ phaseLabel }}</span>
          </div>
        </div>
      </section>

      <section v-if="file" class="card">
        <h3>参数</h3>
        <div class="config-grid">
          <label>
            <span>分片大小</span>
            <select v-model.number="chunkSizeMB" :disabled="isBusy">
              <option v-for="s in chunkSizeOptions" :key="s" :value="s">
                {{ s }} MB
              </option>
            </select>
          </label>
          <label>
            <span>并发数 <em>concurrency</em></span>
            <select v-model.number="concurrency" :disabled="isBusy">
              <option v-for="c in concurrencyOptions" :key="c" :value="c">
                {{ c }}
              </option>
            </select>
          </label>
          <label>
            <span>最大重试 <em>maxRetries</em> · {{ maxRetries }}</span>
            <input v-model.number="maxRetries" type="range" min="0" max="6" :disabled="isBusy">
          </label>
          <label>
            <span>退避基准 <em>retryBaseDelayMs</em> · {{ retryBaseDelay }} ms</span>
            <input v-model.number="retryBaseDelay" type="range" min="100" max="2000" step="100" :disabled="isBusy">
          </label>
          <label>
            <span>模拟失败率 · {{ Math.round(failureRate * 100) }}%</span>
            <input v-model.number="failureRate" type="range" min="0" max="0.8" step="0.05" :disabled="isBusy">
          </label>
          <label>
            <span>模拟处理延时 · {{ minLatency }}–{{ maxLatency }} ms</span>
            <div class="dual-range">
              <input v-model.number="minLatency" type="range" min="0" max="3000" step="50" :disabled="isBusy">
              <input v-model.number="maxLatency" type="range" min="0" max="3000" step="50" :disabled="isBusy">
            </div>
          </label>
        </div>
      </section>

      <section v-if="file" class="card">
        <div class="control-buttons">
          <button class="primary" :disabled="!canStart" @click="start">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 4l14 8-14 8V4z" /></svg>
            开始
          </button>
          <button :disabled="!canPause" @click="pause">
            暂停
          </button>
          <button :disabled="!canResume" @click="resume">
            恢复
          </button>
          <button class="danger" :disabled="!canCancel" @click="cancel">
            取消
          </button>
          <button :disabled="!canHash" @click="hashFile">
            {{ isHashing ? '计算中…' : '计算文件 MD5' }}
          </button>
          <button class="ghost" :disabled="!canReset" @click="reset">
            重置
          </button>
        </div>

        <div class="progress-row">
          <div class="progress-block">
            <div class="progress-label">
              <span>哈希进度</span>
              <span>{{ hashedChunks }} / {{ totalChunks || 0 }}</span>
            </div>
            <div class="progress-bar">
              <div class="bar hash" :style="{ width: `${hashPct}%` }" />
            </div>
          </div>
          <div class="progress-block">
            <div class="progress-label">
              <span>处理进度</span>
              <span>{{ progressPct.toFixed(1) }}%</span>
            </div>
            <div class="progress-bar">
              <div class="bar process" :style="{ width: `${progressPct}%` }" />
            </div>
          </div>
        </div>

        <div v-if="fileHash" class="hash-result">
          <span class="hash-label">FILE · MD5</span>
          <code>{{ fileHash }}</code>
        </div>
      </section>

      <section v-if="chunkStates.length" class="card">
        <div class="card-head">
          <h3>
            分片视图 <span class="muted">{{ chunkStates.length }} 个 · 实时状态</span>
          </h3>
          <div class="legend">
            <span class="dot hashing">哈希中</span>
            <span class="dot hashed">已哈希</span>
            <span class="dot processing">处理中</span>
            <span class="dot retrying">重试中</span>
            <span class="dot completed">完成</span>
            <span class="dot failed">失败</span>
            <span class="dot cancelled">取消</span>
          </div>
        </div>
        <div class="chunk-grid">
          <div
            v-for="c in chunkStates"
            :key="c.index"
            class="chunk"
            :class="c.status"
            :title="`#${c.index} · ${formatBytes(c.size)} · ${c.status}${c.attempts > 1 ? ` · ${c.attempts} 次尝试` : ''}${c.hash ? ` · ${c.hash.slice(0, 8)}…` : ''}`"
          >
            <span class="chunk-index">{{ c.index }}</span>
            <span v-if="c.attempts > 1" class="chunk-retry">×{{ c.attempts }}</span>
          </div>
        </div>
      </section>

      <section v-if="logs.length" class="card">
        <div class="card-head">
          <h3>
            日志 <span class="muted">{{ logs.length }}</span>
          </h3>
          <div class="head-actions">
            <button class="ghost small" @click="showLogs = !showLogs">
              {{ showLogs ? '隐藏' : '显示' }}
            </button>
            <button class="ghost small" @click="clearLogs">
              清空
            </button>
          </div>
        </div>
        <div v-if="showLogs" class="log-list">
          <div v-for="l in logs" :key="l.id" class="log-line" :class="l.level">
            <span class="log-ts">{{ l.ts }}</span>
            <span class="log-msg">{{ l.message }}</span>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      <span>FluxForge · 体验文件分片、并发处理与任务控制</span>
    </footer>
  </div>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  --bg: #07070d;
  --bg-2: #0d0d17;
  --bg-3: #131320;
  --surface: rgba(255, 255, 255, 0.035);
  --surface-2: rgba(255, 255, 255, 0.06);
  --surface-hover: rgba(255, 255, 255, 0.09);
  --border: rgba(255, 255, 255, 0.07);
  --border-strong: rgba(255, 255, 255, 0.15);
  --text: #ebecf2;
  --text-2: #a2a7ba;
  --text-3: #6a6e7f;
  --accent: #818cf8;
  --accent-2: #c084fc;
  --hashing: #f59e0b;
  --hashed: #38bdf8;
  --processing: #818cf8;
  --retrying: #ec4899;
  --completed: #34d399;
  --failed: #f87171;
  --cancelled: #71717a;
}

html,
body,
#app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family:
    'Inter',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    'Hiragino Sans GB',
    'Microsoft Yahei',
    sans-serif;
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.app {
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 8% -10%, rgba(129, 140, 248, 0.18), transparent 55%),
    radial-gradient(1000px 500px at 95% 5%, rgba(192, 132, 252, 0.14), transparent 55%), var(--bg);
}

.hero {
  padding: 32px 24px 20px;
  border-bottom: 1px solid var(--border);
}

.hero-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  color: white;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-radius: 12px;
  box-shadow: 0 10px 24px -10px rgba(129, 140, 248, 0.7);
}

.brand h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.brand p {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
}

.github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  text-decoration: none;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  transition: 0.15s;
}

.github:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--surface);
}

.feature-tags {
  max-width: 1200px;
  margin: 18px auto 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feature-tags span {
  padding: 5px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-2);
  font-size: 12px;
}

.feature-tags b {
  color: var(--accent);
  font-weight: 600;
  margin-right: 2px;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px;
}

.card h3 {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 600;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.card-head h3 {
  margin: 0;
}

.head-actions {
  display: flex;
  gap: 6px;
}

.muted {
  color: var(--text-3);
  font-weight: 400;
  margin-left: 6px;
  font-size: 12px;
}

.drop-zone {
  border: 2px dashed var(--border-strong);
  border-radius: 14px;
  padding: 64px 24px;
  text-align: center;
  cursor: pointer;
  transition: 0.2s;
  background: var(--surface);
}

.drop-zone:hover,
.drop-zone.over {
  border-color: var(--accent);
  background: rgba(129, 140, 248, 0.06);
}

.drop-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}

.drop-icon {
  color: var(--accent);
}
.drop-text {
  font-size: 16px;
}
.drop-text span {
  color: var(--accent);
}
.drop-hint {
  color: var(--text-3);
  font-size: 12.5px;
}

.file-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}

.file-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  border-radius: 10px;
  color: var(--accent);
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  color: var(--text-3);
  font-size: 12px;
  margin-top: 2px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
}

.stat-label {
  color: var(--text-3);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.stat-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat-value span {
  font-size: 12px;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 6px;
}

.stat-value.danger {
  color: var(--failed);
}

.phase {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  background: var(--surface-2);
  color: var(--text-2);
}

.phase[data-phase='running'] {
  background: rgba(129, 140, 248, 0.18);
  color: var(--processing);
}
.phase[data-phase='paused'] {
  background: rgba(245, 158, 11, 0.18);
  color: var(--hashing);
}
.phase[data-phase='completed'] {
  background: rgba(52, 211, 153, 0.18);
  color: var(--completed);
}
.phase[data-phase='cancelled'] {
  background: rgba(113, 113, 122, 0.22);
  color: var(--cancelled);
}
.phase[data-phase='failed'] {
  background: rgba(248, 113, 113, 0.18);
  color: var(--failed);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.config-grid label {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-grid label > span {
  color: var(--text-2);
  font-size: 12px;
  display: flex;
  gap: 6px;
}

.config-grid em {
  color: var(--text-3);
  font-style: normal;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 11px;
}

.config-grid select {
  padding: 8px 10px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
}

.config-grid select:focus {
  outline: none;
  border-color: var(--accent);
}

input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg-3);
  height: 4px;
  border-radius: 2px;
  outline: none;
}

input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid #fff;
  cursor: pointer;
}

input[type='range']::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid #fff;
  cursor: pointer;
}

input[type='range']:disabled {
  opacity: 0.4;
}

.dual-range {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.control-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: 0.15s;
  font-family: inherit;
}

button:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

button.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
  color: white;
  font-weight: 600;
}

button.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

button.danger:hover:not(:disabled) {
  background: rgba(248, 113, 113, 0.12);
  border-color: var(--failed);
  color: var(--failed);
}

button.ghost {
  background: transparent;
}

button.small {
  padding: 4px 10px;
  font-size: 12px;
}

.progress-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.progress-label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.progress-bar {
  height: 6px;
  background: var(--bg-3);
  border-radius: 3px;
  overflow: hidden;
}

.bar {
  height: 100%;
  transition: width 0.2s ease;
  border-radius: 3px;
}

.bar.hash {
  background: linear-gradient(90deg, var(--hashing), var(--hashed));
}
.bar.process {
  background: linear-gradient(90deg, var(--processing), var(--completed));
}

.hash-result {
  margin-top: 14px;
  padding: 10px 14px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
  overflow: hidden;
}

.hash-label {
  color: var(--text-3);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.hash-result code {
  flex: 1;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--completed);
  overflow-x: auto;
  white-space: nowrap;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.legend .dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
}

.legend .dot::before {
  content: '';
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.legend .hashing::before {
  background: var(--hashing);
}
.legend .hashed::before {
  background: var(--hashed);
}
.legend .processing::before {
  background: var(--processing);
}
.legend .retrying::before {
  background: var(--retrying);
}
.legend .completed::before {
  background: var(--completed);
}
.legend .failed::before {
  background: var(--failed);
}
.legend .cancelled::before {
  background: var(--cancelled);
}

.chunk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 4px;
}

.chunk {
  aspect-ratio: 1;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  transition:
    background 0.25s ease,
    color 0.25s ease,
    transform 0.2s ease;
  position: relative;
  background: var(--bg-3);
  border: 1px solid var(--border);
  cursor: default;
}

.chunk-index {
  line-height: 1;
}

.chunk.hashing {
  background: var(--hashing);
  color: #1a1300;
  animation: pulse 1.2s ease-in-out infinite;
}

.chunk.hashed {
  background: var(--hashed);
  color: #062330;
}
.chunk.processing {
  background: var(--processing);
  color: #0d0f29;
  animation: pulse 1s ease-in-out infinite;
}
.chunk.retrying {
  background: var(--retrying);
  color: #2a0317;
  animation: pulse 0.6s ease-in-out infinite;
}
.chunk.completed {
  background: var(--completed);
  color: #052e1f;
}
.chunk.failed {
  background: var(--failed);
  color: #3a0606;
}
.chunk.cancelled {
  background: var(--cancelled);
  color: #18181b;
}

.chunk-retry {
  position: absolute;
  top: 2px;
  right: 3px;
  font-size: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: white;
  padding: 0 4px;
  border-radius: 6px;
  line-height: 1.4;
  font-weight: 600;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.72;
    transform: scale(0.93);
  }
}

.log-list {
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 12px;
}

.log-line {
  padding: 3px 8px;
  display: flex;
  gap: 12px;
  border-radius: 4px;
}

.log-line:hover {
  background: var(--surface);
}

.log-ts {
  color: var(--text-3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.log-msg {
  color: var(--text-2);
}
.log-line.success .log-msg {
  color: var(--completed);
}
.log-line.warn .log-msg {
  color: var(--hashing);
}
.log-line.error .log-msg {
  color: var(--failed);
}

.footer {
  text-align: center;
  padding: 24px;
  color: var(--text-3);
  font-size: 12px;
  border-top: 1px solid var(--border);
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .config-grid {
    grid-template-columns: 1fr 1fr;
  }
  .progress-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .hero {
    padding: 24px 16px 16px;
  }
  .container {
    padding: 16px;
  }
  .hero-inner {
    flex-direction: column;
    align-items: flex-start;
  }
  .config-grid {
    grid-template-columns: 1fr;
  }
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: var(--bg-2);
}
::-webkit-scrollbar-thumb {
  background: var(--surface-2);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--surface-hover);
}
</style>
