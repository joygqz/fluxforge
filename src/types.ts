export interface Chunk {
  blob: Blob
  hash: string
  index: number
  start: number
  end: number
}

export interface ChunkOptions {
  chunkSize?: number
  workerCount?: number
}

export interface ProcessOptions {
  concurrency?: number
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  onProgress?: (completed: number, total: number) => void
}

export type ChunkProcessor = (chunk: Chunk, signal: AbortSignal) => void | Promise<void>

export interface ProcessController {
  pause: () => void
  resume: () => void
  cancel: () => void
  readonly promise: Promise<void>
}

export class CancellationError extends Error {
  constructor(message = 'Task cancelled') {
    super(message)
    this.name = 'CancellationError'
  }
}

export class RetryExhaustedError extends Error {
  readonly cause: unknown
  readonly attempts: number

  constructor(attempts: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Retry exhausted after ${attempts} attempts: ${reason}`)
    this.name = 'RetryExhaustedError'
    this.cause = cause
    this.attempts = attempts
  }
}

export interface WorkerRequest {
  start: number
  end: number
  chunkSize: number
  file: File
}

export type WorkerResponse
  = | { type: 'chunk', index: number, start: number, end: number, hash: string }
    | { type: 'error', index: number, message: string }
