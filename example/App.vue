<script setup lang="ts">
import type { Chunk, ProcessController } from '../src'
import { computed, ref } from 'vue'
import { calculateFileHash, CancellationError, chunkFile, collectChunks, processChunks } from '../src'

const file = ref<File | null>(null)
const logs = ref<string[]>([])
const isProcessing = ref(false)
const chunkSize = ref(2 * 1024 * 1024)
const concurrency = ref(6)
const completedCount = ref(0)
const totalCount = ref(0)
const isPaused = ref(false)
const isCancelled = ref(false)

const progress = computed(() => {
  if (totalCount.value === 0)
    return 0
  return (completedCount.value / totalCount.value) * 100
})

let chunkPromises: Promise<Chunk>[] = []
let controller: ProcessController | null = null

const chunkSizeOptions = [
  { label: '1MB', value: 1024 * 1024 },
  { label: '2MB', value: 2 * 1024 * 1024 },
  { label: '4MB', value: 4 * 1024 * 1024 },
  { label: '8MB', value: 8 * 1024 * 1024 },
]

function addLog(message: string) {
  logs.value.push(`[${new Date().toLocaleTimeString()}] ${message}`)
}

function resetState() {
  chunkPromises = []
  completedCount.value = 0
  totalCount.value = 0
  isPaused.value = false
  isCancelled.value = false
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length)
    return
  file.value = input.files[0]
  resetState()
  addLog(`已选择文件: ${file.value.name}`)
  addLog(`文件信息: ${(file.value.size / 1024 / 1024).toFixed(2)} MB, ${file.value.type || '未知类型'}`)
}

function createChunks() {
  if (!file.value)
    return

  try {
    isProcessing.value = true
    addLog(`开始切片: ${file.value.name}`)
    addLog(`切片大小: ${(chunkSize.value / 1024 / 1024).toFixed(2)} MB`)

    const startTime = performance.now()
    chunkPromises = chunkFile(file.value, { chunkSize: chunkSize.value })
    const duration = (performance.now() - startTime).toFixed(0)

    completedCount.value = 0
    totalCount.value = chunkPromises.length
    addLog(`已创建 ${chunkPromises.length} 个切片 Promise（耗时 ${duration}ms）`)
  }
  catch (error) {
    addLog(`切片创建失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isProcessing.value = false
  }
}

async function processAllChunks() {
  if (!chunkPromises.length)
    return

  isPaused.value = false
  isCancelled.value = false
  isProcessing.value = true
  addLog(`开始处理 ${chunkPromises.length} 个切片，并发数 ${concurrency.value}`)

  let attempts = 0
  let failures = 0

  controller = processChunks(
    chunkPromises,
    async (chunk, signal) => {
      attempts++
      addLog(`#${chunk.index} 处理中 (${chunk.start}-${chunk.end} bytes)`)

      const processingTime = Math.random() * 1000 + 500
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, processingTime)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }, { once: true })
      })

      if (Math.random() < 0.3) {
        failures++
        addLog(`#${chunk.index} 模拟失败（将自动重试）`)
        throw new Error(`chunk ${chunk.index} failed`)
      }

      addLog(`#${chunk.index} 处理成功 (hash: ${chunk.hash.substring(0, 8)}...)`)
    },
    {
      concurrency: concurrency.value,
      onProgress: (completed, total) => {
        completedCount.value = completed
        totalCount.value = total
      },
    },
  )

  try {
    await controller.promise
    addLog(`所有切片处理完成！总尝试: ${attempts}，失败重试: ${failures}`)
  }
  catch (error) {
    if (error instanceof CancellationError)
      addLog('处理已被取消')
    else
      addLog(`处理失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isProcessing.value = false
    isPaused.value = false
    isCancelled.value = false
    controller = null
  }
}

function pauseProcessing() {
  if (!controller)
    return
  controller.pause()
  isPaused.value = true
  addLog('已暂停')
}

function resumeProcessing() {
  if (!controller)
    return
  controller.resume()
  isPaused.value = false
  addLog('已恢复')
}

function cancelProcessing() {
  if (!controller)
    return
  controller.cancel()
  isCancelled.value = true
  addLog('已请求取消')
}

async function calculateHash() {
  if (!chunkPromises.length)
    return

  try {
    isProcessing.value = true
    addLog('开始计算文件 MD5...')
    const startTime = performance.now()

    const hash = await calculateFileHash(chunkPromises)
    const duration = (performance.now() - startTime).toFixed(0)

    addLog(`文件 MD5: ${hash}`)
    addLog(`计算耗时: ${duration}ms`)
  }
  catch (error) {
    addLog(`MD5 计算失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isProcessing.value = false
  }
}

async function handleCollectChunks() {
  if (!chunkPromises.length)
    return

  try {
    isProcessing.value = true
    addLog('收集所有切片...')
    const startTime = performance.now()

    const chunks = await collectChunks(chunkPromises)
    const duration = (performance.now() - startTime).toFixed(0)
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0)

    addLog(`已收集 ${chunks.length} 个切片，总大小 ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
    addLog(`耗时: ${duration}ms`)
  }
  catch (error) {
    addLog(`收集切片失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isProcessing.value = false
  }
}
</script>

<template>
  <div class="container">
    <h1>FluxForge Demo</h1>

    <div class="main">
      <div class="controls">
        <div class="section">
          <h3>选择文件</h3>
          <input type="file" :disabled="isProcessing" @change="handleFileChange">

          <div v-if="file" class="settings">
            <div>
              <label>切片大小</label>
              <select v-model="chunkSize" :disabled="isProcessing">
                <option v-for="option in chunkSizeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>

            <div class="buttons">
              <button :disabled="isProcessing" @click="createChunks">
                创建切片
              </button>
            </div>

            <div class="buttons">
              <div>
                <label>并发处理数</label>
                <input v-model.number="concurrency" type="number" min="1" max="16" :disabled="isProcessing">
              </div>
              <button
                :disabled="isProcessing || !chunkPromises.length"
                @click="processAllChunks"
              >
                模拟处理切片 ({{ completedCount }} / {{ totalCount }})
              </button>
              <progress max="100" :value="progress" />
              <div class="button-row">
                <button :disabled="!isProcessing || isPaused || isCancelled" @click="pauseProcessing">
                  暂停
                </button>
                <button :disabled="!isProcessing || !isPaused || isCancelled" @click="resumeProcessing">
                  恢复
                </button>
                <button :disabled="!isProcessing || isCancelled" @click="cancelProcessing">
                  取消
                </button>
              </div>
              <button :disabled="isProcessing || !chunkPromises.length" @click="calculateHash">
                计算 MD5
              </button>
            </div>

            <div class="buttons">
              <button :disabled="isProcessing || !chunkPromises.length" @click="handleCollectChunks">
                收集所有切片
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="logs">
        <h3>日志</h3>
        <div class="log-content">
          <div v-if="!logs.length" class="empty">
            请选择文件开始...
          </div>
          <div v-for="(log, index) in logs" :key="index">
            {{ log }}
          </div>
        </div>
        <button v-if="logs.length" @click="logs = []">
          清空日志
        </button>
      </div>
    </div>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f5f5f5;
}

.container {
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px;
}

h1 {
  text-align: center;
  color: #333;
  margin-bottom: 30px;
  font-size: 2.2rem;
}

h3 {
  margin-top: 0;
  font-size: 1.2rem;
}

.main {
  display: flex;
  gap: 20px;
}

.controls {
  flex: 0 0 300px;
}

.logs {
  flex: 1;
}

.section {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.settings > div {
  margin-bottom: 15px;
}

label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
  color: #333;
}

input,
select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

input:focus,
select:focus {
  outline: none;
  border-color: #007bff;
}

.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}

.button-row {
  display: flex;
  gap: 8px;
}

.button-row button {
  flex: 1;
}

progress {
  width: 100%;
  height: 8px;
}

button {
  padding: 10px 16px;
  border: none;
  border-radius: 4px;
  background: #007bff;
  color: white;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.2s;
}

button:hover:not(:disabled) {
  background: #0056b3;
}

button:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.log-content {
  background: #2d3748;
  color: #e2e8f0;
  padding: 15px;
  border-radius: 4px;
  height: 400px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.4;
  margin-bottom: 10px;
}

.empty {
  color: #888;
  font-style: italic;
  text-align: center;
  padding: 20px;
}

@media (max-width: 768px) {
  .main {
    flex-direction: column;
  }

  .controls {
    flex: none;
  }
}
</style>
