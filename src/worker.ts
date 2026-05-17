import type { WorkerRequest, WorkerResponse } from './types'
import SparkMD5 from 'spark-md5'

async function hashRange(file: File, index: number, chunkSize: number): Promise<WorkerResponse> {
  const start = index * chunkSize
  const end = Math.min(start + chunkSize, file.size)
  const blob = file.slice(start, end)
  const buffer = await blob.arrayBuffer()

  const hasher = new SparkMD5.ArrayBuffer()
  hasher.append(buffer)

  return { type: 'chunk', index, start, end, hash: hasher.end() }
}

onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const { file, chunkSize, start, end } = data

  for (let i = start; i < end; i++) {
    try {
      const response = await hashRange(file, i, chunkSize)
      ;(postMessage as (msg: WorkerResponse) => void)(response)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ;(postMessage as (msg: WorkerResponse) => void)({ type: 'error', index: i, message })
      return
    }
  }
}
