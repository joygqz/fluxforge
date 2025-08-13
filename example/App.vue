<script setup lang="ts">
import type { Chunk } from 'fluxforge'
import { calculateFileHash, chunkFile, collectChunks, processChunks } from 'fluxforge'
import { computed, ref } from 'vue'

const file = ref<File | null>(null)
const logs = ref<string[]>([])
const isProcessing = ref(false)
const chunkSize = ref(2 * 1024 * 1024) // 2MB (更优的默认值)
const concurrency = ref(6) // 更优的默认并发数
const completedCount = ref(0)
const totalCount = ref(0)
const progress = computed(() => (completedCount.value / totalCount.value) * 100 || 0)
let chunkPromises: Promise<Chunk>[] = []
let controller: ReturnType<typeof processChunks> | null = null
const isPaused = ref(false)
const isCancelled = ref(false)

const chunkSizeOptions = [
  { label: '1MB', value: 1024 * 1024 },
  { label: '2MB', value: 2 * 1024 * 1024 },
  { label: '4MB', value: 4 * 1024 * 1024 },
  { label: '8MB', value: 8 * 1024 * 1024 },
]

function addLog(message: string) {
  logs.value.push(`[${new Date().toLocaleTimeString()}] ${message}`)
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files?.length) {
    file.value = input.files[0]
    // 重置状态
    chunkPromises = []
    completedCount.value = 0
    totalCount.value = 0
    addLog(`📁 已选择文件: ${file.value.name}`)
    addLog(`📊 文件信息: ${(file.value.size / 1024 / 1024).toFixed(2)} MB, ${file.value.type || '未知类型'}`)
  }
}

async function createChunks() {
  if (!file.value)
    return

  try {
    isProcessing.value = true
    addLog(`🔄 开始切片文件: ${file.value.name}`)
    addLog(`📏 文件大小: ${(file.value.size / 1024 / 1024).toFixed(2)} MB`)
    addLog(`⚙️ 切片大小: ${(chunkSize.value / 1024 / 1024).toFixed(2)} MB`)

    const startTime = Date.now()
    chunkPromises = chunkFile(file.value, { chunkSize: chunkSize.value })
    const duration = Date.now() - startTime

    addLog(`✅ 已创建 ${chunkPromises.length} 个切片Promise (${duration}ms)`)
    addLog(`🧵 使用 ${Math.min(navigator.hardwareConcurrency || 4, Math.ceil(file.value.size / chunkSize.value))} 个Web Worker并行处理`)
    addLog(`⚡ 切片任务正在后台并行执行...`)

    // 重置进度
    completedCount.value = 0
    totalCount.value = chunkPromises.length
  }
  catch (error) {
    addLog(`❌ 切片创建失败: ${error instanceof Error ? error.message : String(error)}`)
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

  try {
    isProcessing.value = true
    addLog(`开始处理 ${chunkPromises.length} 个切片（并发数: ${concurrency.value}）`)

    let uploadAttempts = 0
    let failedAttempts = 0

    controller = processChunks(
      chunkPromises,
      async (chunk, signal) => {
        // 立即响应取消信号
        if (signal.aborted) {
          if (signal.aborted) {
            failedAttempts++
            addLog(`⏹️ 切片 #${chunk.index} 被中断`)
            throw new Error('aborted')
          }
        }

        uploadAttempts++
        addLog(`📤 切片 #${chunk.index} 开始处理 (${chunk.start}-${chunk.end} bytes)`)

        // 模拟处理时间（上传、转换等）
        const processingTime = Math.random() * 1000 + 500
        await new Promise(resolve => setTimeout(resolve, processingTime))

        // 再次检查取消状态
        if (signal.aborted) {
          addLog(`⏹️ 切片 #${chunk.index} 被中断`)
          throw new Error('aborted')
        }

        // 模拟随机失败（30%概率），触发自动重试
        if (Math.random() < 0.3) {
          failedAttempts++
          addLog(`❌ 切片 #${chunk.index} 处理失败（将自动重试）`)
          throw new Error(`切片 ${chunk.index} 处理失败`)
        }

        addLog(`✅ 切片 #${chunk.index} 处理成功 (hash: ${chunk.hash.substring(0, 8)}...)`)
      },
      {
        concurrency: concurrency.value,
        onProgress: (completed, total) => {
          completedCount.value = completed
          totalCount.value = total
          addLog(`📊 进度更新: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`)
        },
      },
    )

    await controller.promise
    addLog(`🎉 所有切片处理完成！总计: ${chunkPromises.length}，失败重试: ${failedAttempts}，总尝试: ${uploadAttempts}`)
  }
  catch (error) {
    if (isCancelled.value) {
      addLog('⏹️ 处理已被用户取消')
    }
    else {
      addLog(`❌ 处理失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  finally {
    isProcessing.value = false
    isPaused.value = false
    isCancelled.value = false
    controller = null
  }
}

function pauseProcessing() {
  if (controller) {
    controller.pause()
    isPaused.value = true
    addLog('⏸️ 已暂停处理')
  }
}
function resumeProcessing() {
  if (controller) {
    controller.resume()
    isPaused.value = false
    addLog('▶️ 已恢复处理')
  }
}
function cancelProcessing() {
  if (controller) {
    controller.cancel()
    isCancelled.value = true
    addLog('⏹️ 已请求取消处理')
  }
}

async function calculateHash() {
  if (!chunkPromises.length)
    return

  try {
    isProcessing.value = true
    addLog('🔍 正在计算文件 MD5 哈希值...')
    const startTime = Date.now()

    const hash = await calculateFileHash(chunkPromises)
    const duration = Date.now() - startTime

    addLog(`🔐 文件 MD5: ${hash}`)
    addLog(`⏱️ 计算耗时: ${duration}ms`)
  }
  catch (error) {
    addLog(`❌ MD5 计算失败: ${error instanceof Error ? error.message : String(error)}`)
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
    addLog('📦 正在收集所有切片数据...')
    const startTime = Date.now()

    const chunks = await collectChunks(chunkPromises)
    const duration = Date.now() - startTime
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0)

    addLog(`✅ 已收集所有切片：共 ${chunks.length} 个`)
    addLog(`📊 总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
    addLog(`⏱️ 收集耗时: ${duration}ms`)

    // 输出到控制台供调试
    console.log('Collected chunks:', chunks)
  }
  catch (error) {
    addLog(`❌ 收集切片失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isProcessing.value = false
  }
}
</script>

<template>
  <div class="container">
    <h1 style="font-size:2.2rem">
      FluxForge Demo
    </h1>

    <div class="main">
      <div class="controls">
        <div class="section">
          <h3 style="font-size:1.2rem">
            选择文件 / Select File
          </h3>
          <input type="file" :disabled="isProcessing" @change="handleFileChange">

          <div v-if="file" class="settings">
            <div>
              <label style="font-size:1rem">切片大小 / Chunk Size：</label>
              <select v-model="chunkSize" :disabled="isProcessing">
                <option v-for="option in chunkSizeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>

            <div class="buttons">
              <button :disabled="isProcessing" style="font-size:1rem" @click="createChunks">
                创建切片<br>
                Create Chunks
              </button>
            </div>
            <div class="buttons">
              <div>
                <label style="font-size:1rem">并发处理数 / Concurrency：</label>
                <input v-model="concurrency" type="number" min="1" max="16" :disabled="isProcessing">
              </div>
              <button
                :disabled="isProcessing || !chunkPromises.length" style="font-size:1rem"
                @click="processAllChunks"
              >
                处理切片<br>
                Process Chunks<br>
                {{ completedCount }} / {{ totalCount }}
              </button>
              <progress max="100" :value="progress" style="width: 100%" />
              <div style="display: flex; gap: 8px">
                <button
                  :disabled="!isProcessing || isPaused || isCancelled" style="font-size:1rem"
                  @click="pauseProcessing"
                >
                  暂停<br>
                  Pause
                </button>
                <button
                  :disabled="!isProcessing || !isPaused || isCancelled" style="font-size:1rem"
                  @click="resumeProcessing"
                >
                  恢复<br>
                  Resume
                </button>
                <button :disabled="!isProcessing || isCancelled" style="font-size:1rem" @click="cancelProcessing">
                  取消<br>
                  Cancel
                </button>
              </div>
              <button :disabled="isProcessing || !chunkPromises.length" style="font-size:1rem" @click="calculateHash">
                计算 MD5<br>
                Calculate MD5
              </button>
            </div>
            <div class="buttons">
              <button :disabled="isProcessing || !chunkPromises.length" style="font-size:1rem" @click="handleCollectChunks">
                收集所有块<br>
                Collect All Chunks
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="logs">
        <h3 style="font-size:1.2rem">
          日志 / Logs
        </h3>
        <div class="log-content">
          <div v-if="!logs.length" class="empty">
            请选择文件开始... / Please select a file to start...
          </div>
          <div v-for="(log, index) in logs" :key="index">
            {{ log }}
          </div>
        </div>
        <button v-if="logs.length" style="font-size:1rem" @click="logs = []">
          清空日志 / Clear Logs
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

.settings {
  margin-top: 15px;
}

.settings > div {
  margin-bottom: 15px;
}

label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
  color: #333;
  font-size: 1rem;
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
