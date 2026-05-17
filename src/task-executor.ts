import { CancellationError, RetryExhaustedError } from './types'

export class TaskController {
  private paused = false
  private cancelled = false
  private pauseResolvers = new Set<() => void>()
  private delayHandles = new Set<{ cancel: () => void }>()
  private abortController = new AbortController()

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  throwIfCancelled(): void {
    if (this.cancelled)
      throw new CancellationError()
  }

  async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise<void>((resolve) => {
        this.pauseResolvers.add(resolve)
      })
    }
    this.throwIfCancelled()
  }

  async delay(ms: number): Promise<void> {
    if (ms <= 0)
      return
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const handle = {
        cancel: () => {
          clearTimeout(timer)
          this.delayHandles.delete(handle)
          resolve()
        },
      }
      timer = setTimeout(() => {
        this.delayHandles.delete(handle)
        resolve()
      }, ms)
      this.delayHandles.add(handle)
    })
  }

  pause(): void {
    if (this.cancelled || this.paused)
      return
    this.paused = true
  }

  resume(): void {
    if (!this.paused)
      return
    this.paused = false
    const resolvers = [...this.pauseResolvers]
    this.pauseResolvers.clear()
    resolvers.forEach(resolve => resolve())
  }

  cancel(): void {
    if (this.cancelled)
      return
    this.cancelled = true
    this.paused = false
    this.abortController.abort()
    this.flushDelays()
    const resolvers = [...this.pauseResolvers]
    this.pauseResolvers.clear()
    resolvers.forEach(resolve => resolve())
  }

  cleanup(): void {
    this.flushDelays()
    this.pauseResolvers.clear()
  }

  private flushDelays(): void {
    const handles = [...this.delayHandles]
    this.delayHandles.clear()
    handles.forEach(h => h.cancel())
  }
}

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  controller: TaskController,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = options
  let attempt = 0
  let lastError: unknown

  while (true) {
    controller.throwIfCancelled()
    await controller.waitWhilePaused()

    try {
      return await fn()
    }
    catch (error) {
      if (error instanceof CancellationError)
        throw error
      if (controller.isCancelled)
        throw new CancellationError()

      lastError = error
      if (attempt >= maxRetries)
        throw new RetryExhaustedError(attempt + 1, lastError)

      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)
      attempt++
      await controller.delay(backoff)
    }
  }
}
