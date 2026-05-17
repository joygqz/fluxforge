import type {
  Chunk,
  ChunkOptions,
  ChunkProcessor,
  ProcessController,
  ProcessOptions,
  WorkerRequest,
  WorkerResponse,
} from './types'
import SparkMD5 from 'spark-md5'
import { executeWithRetry, TaskController } from './task-executor'
import Worker from './worker?worker&inline'

export type {
  Chunk,
  ChunkOptions,
  ChunkProcessor,
  ProcessController,
  ProcessOptions,
}
export { CancellationError, RetryExhaustedError } from './types'

const DEFAULT_CHUNK_SIZE = 1024 * 1024
const DEFAULT_CONCURRENCY = 6
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_DELAY = 500
const DEFAULT_RETRY_MAX_DELAY = 5000

interface ChunkResolver {
  resolve: (chunk: Chunk) => void
  reject: (error: unknown) => void
}

function spawnWorker(
  file: File,
  request: WorkerRequest,
  resolvers: Map<number, ChunkResolver>,
): Worker {
  const worker = new Worker()

  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const resolver = resolvers.get(data.index)
    if (!resolver)
      return
    resolvers.delete(data.index)

    if (data.type === 'error') {
      resolver.reject(new Error(`Failed to hash chunk #${data.index}: ${data.message}`))
      return
    }

    resolver.resolve({
      index: data.index,
      start: data.start,
      end: data.end,
      hash: data.hash,
      blob: file.slice(data.start, data.end),
    })
  }

  worker.onerror = (event) => {
    for (let i = request.start; i < request.end; i++) {
      const resolver = resolvers.get(i)
      if (resolver) {
        resolvers.delete(i)
        resolver.reject(new Error(`Worker error: ${event.message || 'unknown'}`))
      }
    }
  }

  worker.postMessage(request)
  return worker
}

export function chunkFile(file: File, options: ChunkOptions = {}): Promise<Chunk>[] {
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function')
    throw new TypeError('chunkFile expects a File or Blob')
  if (file.size === 0)
    return []

  const chunkSize = options.chunkSize ?? Math.min(DEFAULT_CHUNK_SIZE, file.size)
  if (!Number.isFinite(chunkSize) || chunkSize <= 0)
    throw new RangeError('chunkSize must be a positive number')

  const totalChunks = Math.ceil(file.size / chunkSize)
  const hardware = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  const workerCount = Math.max(1, Math.min(options.workerCount ?? hardware, totalChunks))

  const resolvers = new Map<number, ChunkResolver>()
  const promises = Array.from({ length: totalChunks }, (_, i) =>
    new Promise<Chunk>((resolve, reject) => {
      resolvers.set(i, { resolve, reject })
    }))

  const chunksPerWorker = Math.ceil(totalChunks / workerCount)
  const workers: Worker[] = []
  for (let i = 0; i < workerCount; i++) {
    const start = i * chunksPerWorker
    if (start >= totalChunks)
      break
    const end = Math.min(start + chunksPerWorker, totalChunks)
    workers.push(spawnWorker(file, { file, chunkSize, start, end }, resolvers))
  }

  Promise.allSettled(promises).finally(() => {
    workers.forEach(w => w.terminate())
    resolvers.clear()
  })

  return promises
}

export function processChunks(
  chunkPromises: Promise<Chunk>[],
  processor: ChunkProcessor,
  options: ProcessOptions = {},
): ProcessController {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY,
    onProgress,
  } = options

  if (concurrency < 1)
    throw new RangeError('concurrency must be >= 1')
  if (maxRetries < 0)
    throw new RangeError('maxRetries must be >= 0')

  const controller = new TaskController()
  const total = chunkPromises.length
  const executing = new Set<Promise<void>>()
  let completed = 0

  const runOne = async (chunkPromise: Promise<Chunk>): Promise<void> => {
    const chunk = await chunkPromise
    await executeWithRetry(
      () => Promise.resolve(processor(chunk, controller.signal)),
      controller,
      { maxRetries, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs },
    )
    completed++
    onProgress?.(completed, total)
  }

  const mainPromise = (async () => {
    try {
      for (const chunkPromise of chunkPromises) {
        controller.throwIfCancelled()
        await controller.waitWhilePaused()

        const task = runOne(chunkPromise).finally(() => executing.delete(task))
        executing.add(task)

        if (executing.size >= concurrency)
          await Promise.race([...executing].map(p => p.catch(() => undefined)))
      }
      await Promise.all(executing)
    }
    finally {
      await Promise.allSettled(executing)
      controller.cleanup()
    }
  })()

  return {
    pause: () => controller.pause(),
    resume: () => controller.resume(),
    cancel: () => controller.cancel(),
    promise: mainPromise,
  }
}

export async function collectChunks(chunkPromises: Promise<Chunk>[]): Promise<Chunk[]> {
  return Promise.all(chunkPromises)
}

export async function calculateFileHash(chunkPromises: Promise<Chunk>[]): Promise<string> {
  const hasher = new SparkMD5.ArrayBuffer()
  for (const chunkPromise of chunkPromises) {
    const chunk = await chunkPromise
    const buffer = await chunk.blob.arrayBuffer()
    hasher.append(buffer)
  }
  return hasher.end()
}
