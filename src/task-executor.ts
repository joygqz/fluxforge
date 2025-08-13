// 任务控制器
export class TaskController {
  private paused = false
  private cancelled = false
  private pauseResolvers: Array<() => void> = []
  private timers: Array<{ timer: number, resolve: () => void }> = []
  private abortController = new AbortController()

  // 获取当前的 AbortSignal，用于传递给异步任务
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  // 检查任务是否已取消，若已取消则抛出错误
  checkCancelled(): void {
    if (this.cancelled)
      throw new Error('Task cancelled')
  }

  // 如果任务被暂停，则等待恢复
  async waitIfPaused(): Promise<void> {
    if (!this.paused)
      return

    await new Promise<void>((resolve) => {
      this.pauseResolvers.push(resolve)
    })
  }

  // 延迟指定时间，支持取消
  async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.timers.push({ timer, resolve })
    })
  }

  // 取消所有重试延迟，并立即执行其回调
  private clearTimers(): void {
    this.timers.splice(0).forEach(({ timer, resolve }) => {
      clearTimeout(timer)
      resolve()
    })
  }

  // 暂停任务
  pause(): void {
    this.paused = true
    this.abortController.abort()
    this.clearTimers()
  }

  // 恢复任务
  resume(): void {
    if (!this.paused)
      return

    this.paused = false
    this.abortController = new AbortController()
    this.clearTimers()
    this.pauseResolvers.splice(0).forEach(resolve => resolve())
  }

  // 取消任务
  cancel(): void {
    this.cancelled = true
    this.abortController.abort()
    this.clearTimers()

    if (this.paused) {
      this.paused = false
      this.pauseResolvers.splice(0).forEach(resolve => resolve())
    }
  }

  // 清理状态，防止内存泄漏
  cleanup(): void {
    this.paused = false
    this.pauseResolvers.length = 0
    this.clearTimers()
  }
}

// 带重试的任务执行器
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  controller: TaskController,
): Promise<T> {
  let retry = 0

  while (true) {
    controller.checkCancelled()
    await controller.waitIfPaused()
    controller.checkCancelled()

    try {
      return await fn()
    }
    catch {
      // 指数退避重试：0s, 1s, 2s, 3s, 4s, 5s...
      const delay = Math.min(1000 * retry++, 5000)
      await controller.delay(delay)
    }
  }
}
