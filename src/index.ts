import SparkMD5 from 'spark-md5'
import { executeWithRetry, TaskController } from './task-executor'
import Worker from './worker?worker&inline'

export interface Chunk {
  blob: Blob
  hash: string
  index: number
  start: number
  end: number
}

export interface Options {
  chunkSize?: number
}

export interface ProcessOptions {
  concurrency?: number
  onProgress?: (completed: number, total: number) => void
}

export type ChunkProcessor = (chunk: Chunk, signal: AbortSignal) => void | Promise<void>

export interface ProcessController {
  pause: () => void
  resume: () => void
  cancel: () => void
  promise: Promise<void>
}

interface ChunkResolver {
  resolve: (chunk: Chunk) => void
  reject: (error: unknown) => void
}

// 创建一个 Web Worker 来处理文件块
function createWorker(
  file: File,
  chunkSize: number,
  start: number,
  end: number,
  resolvers: Map<number, ChunkResolver>,
): Worker {
  const worker = new Worker()

  worker.onmessage = ({ data }) => {
    const { chunk, chunkIndex } = data
    const index = start + chunkIndex
    const resolver = resolvers.get(index)!

    resolver.resolve(chunk)
    resolvers.delete(index)
  }

  worker.postMessage({ file, chunkSize, start, end })
  return worker
}

// 切割文件为块，返回每个块的 Promise
export function chunkFile(file: File, options: Options = {}): Promise<Chunk>[] {
  if (!file?.size)
    throw new Error('Invalid or empty file')
  const { chunkSize = Math.min(1024 * 1024, file.size) } = options
  const threadCount = Math.min(navigator.hardwareConcurrency || 4, Math.ceil(file.size / chunkSize))
  const totalChunks = Math.ceil(file.size / chunkSize)
  const resolvers = new Map<number, ChunkResolver>()

  const promises = Array.from({ length: totalChunks }, (_, i) =>
    new Promise<Chunk>((resolve, reject) => resolvers.set(i, { resolve, reject })))

  const chunksPerThread = Math.ceil(totalChunks / threadCount)
  const workers = Array.from({ length: Math.min(threadCount, totalChunks) }, (_, i) =>
    createWorker(file, chunkSize, i * chunksPerThread, Math.min((i + 1) * chunksPerThread, totalChunks), resolvers))

  Promise.allSettled(promises).finally(() => workers.forEach(w => w.terminate()))

  return promises
}

// 并发处理文件块
export function processChunks(
  chunkPromises: Promise<Chunk>[],
  processor: ChunkProcessor,
  options: ProcessOptions = {},
): ProcessController {
  const { concurrency = 6, onProgress } = options
  const controller = new TaskController()
  const executing = new Set<Promise<void>>()
  let completed = 0

  // 处理单个块
  const processChunk = async (chunkPromise: Promise<Chunk>): Promise<void> => {
    const chunk = await chunkPromise

    await executeWithRetry(async () => {
      await processor(chunk, controller.signal)
      completed++
      onProgress?.(completed, chunkPromises.length)
    }, controller)
  }

  const mainPromise = (async () => {
    try {
      for (const chunkPromise of chunkPromises) {
        controller.checkCancelled()

        const promise = processChunk(chunkPromise).finally(() => executing.delete(promise))
        executing.add(promise)

        // 并发控制：达到最大并发数时等待
        if (executing.size >= concurrency) {
          await Promise.race(executing)
          controller.checkCancelled()
        }
      }

      await Promise.all(executing)
    }
    finally {
      controller.cleanup()
      executing.clear()
    }
  })()

  return {
    pause: () => controller.pause(),
    resume: () => controller.resume(),
    cancel: () => controller.cancel(),
    promise: mainPromise,
  }
}

// 计算文件的整体 MD5
export async function calculateFileHash(chunkPromises: Promise<Chunk>[]): Promise<string> {
  const chunks = await Promise.all(chunkPromises)
  const hasher = new SparkMD5()

  chunks.forEach(chunk => hasher.append(chunk.hash))
  return hasher.end()
}

// 收集所有块
export async function collectChunks(chunkPromises: Promise<Chunk>[]): Promise<Chunk[]> {
  return Promise.all(chunkPromises)
}
