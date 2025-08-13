import type { Chunk } from './index'
import SparkMD5 from 'spark-md5'

// 处理单个文件块
async function processChunk(file: File, index: number, chunkSize: number): Promise<Chunk> {
  while (true) {
    try {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const blob = file.slice(start, end)
      const buffer = await blob.arrayBuffer()

      const hasher = new SparkMD5.ArrayBuffer()
      hasher.append(buffer)

      return { index, start, end, hash: hasher.end(), blob }
    }
    catch {
      // 重试直到成功
    }
  }
}

onmessage = async ({ data }) => {
  const { file, chunkSize, start, end } = data

  for (let i = start; i < end; i++) {
    const chunk = await processChunk(file, i, chunkSize)
    postMessage({ type: 'chunk', chunk, chunkIndex: i - start })
  }
}
