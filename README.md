# FluxForge [![NPM Version](https://img.shields.io/npm/v/fluxforge)](https://www.npmjs.com/package/fluxforge) [![NPM Downloads](https://img.shields.io/npm/dm/fluxforge)](https://www.npmjs.com/package/fluxforge)

基于 Web Worker 的浏览器端文件分片库，提供并发任务处理、可暂停/取消的任务控制、可配置的自动重试以及 MD5 校验。

> [在线演示](https://joygqz.github.io/fluxforge/)

## 特性

- **多 Worker 并行分片哈希**：根据 `navigator.hardwareConcurrency` 调度多个 Worker，并行计算每个分片的 MD5。
- **可控的并发处理**：通过用户提供的处理函数串接上传 / 转换等业务逻辑，支持上限并发。
- **任务生命周期管理**：`pause` 暂停后续任务、`resume` 恢复、`cancel` 通过 `AbortSignal` 通知正在运行的处理函数立即终止。
- **可配置的自动重试**：基于指数退避的重试，提供 `maxRetries`、`retryBaseDelayMs`、`retryMaxDelayMs` 三个参数，超过上限会抛出 `RetryExhaustedError` 并附带最后一次错误。
- **真实的文件 MD5**：`calculateFileHash` 按顺序读取分片并增量喂入 SparkMD5，结果与对原始文件做 `md5sum` 一致。
- **TypeScript 优先**：完整的类型定义；导出 `CancellationError`、`RetryExhaustedError` 便于业务做精确判断。

> 说明：MD5 适合做完整性校验（与服务端比对），**不适用于安全场景**（如密码、签名）。

## 安装

```bash
pnpm add fluxforge
# 或
npm install fluxforge
```

## 快速开始

```ts
import { calculateFileHash, CancellationError, chunkFile, processChunks, RetryExhaustedError } from 'fluxforge'

// 1. 切分文件 —— 返回与分片一一对应的 Promise 数组（顺序与索引一致）
const chunkPromises = chunkFile(file, {
  chunkSize: 4 * 1024 * 1024, // 4 MiB
})

// 2. 并发处理每个分片
const controller = processChunks(
  chunkPromises,
  async (chunk, signal) => {
    // 业务逻辑：上传、转码、加密等
    await uploadChunk(chunk.blob, chunk.index, { signal })
  },
  {
    concurrency: 6,
    maxRetries: 3,
    onProgress: (done, total) => {
      updateUi(done / total)
    },
  },
)

// 3. 任务控制
// controller.pause()
// controller.resume()
// controller.cancel()

try {
  await controller.promise
}
catch (error) {
  if (error instanceof CancellationError) {
    // 被显式取消
  }
  else if (error instanceof RetryExhaustedError) {
    // 超过重试上限，error.cause 是最后一次错误
    console.error('Upload failed:', error.cause)
  }
  else {
    throw error
  }
}

// 4. （可选）计算整个文件的 MD5
const md5 = await calculateFileHash(chunkPromises)
```

## API

### `chunkFile(file, options?)`

```ts
function chunkFile(file: File, options?: ChunkOptions): Promise<Chunk>[]
```

把文件切成若干分片，每个分片由内部 Worker 计算 MD5。返回的 Promise 数组按分片索引顺序排列，可以独立 `await` 单个分片。

`ChunkOptions`：

| 字段          | 默认值                                 | 说明                                            |
| ------------- | -------------------------------------- | ----------------------------------------------- |
| `chunkSize`   | `min(1 MiB, file.size)`                | 单个分片字节数，必须 `> 0`                      |
| `workerCount` | `navigator.hardwareConcurrency \|\| 4` | 启动的 Worker 数；自动夹紧到 `[1, totalChunks]` |

- 文件大小为 `0` 时返回 `[]`。
- 若 Worker 内部失败（例如文件已被释放），对应 Promise 会 reject。

### `processChunks(chunkPromises, processor, options?)`

```ts
function processChunks(
  chunkPromises: Promise<Chunk>[],
  processor: ChunkProcessor,
  options?: ProcessOptions,
): ProcessController
```

并发执行 `processor`，并提供任务控制与重试。

`ChunkProcessor`：

```ts
type ChunkProcessor = (chunk: Chunk, signal: AbortSignal) => void | Promise<void>
```

- `chunk` 即解析后的分片；
- `signal` 在 `cancel()` 时触发，处理函数应在合适位置检查或转发给 `fetch` 等。

`ProcessOptions`：

| 字段               | 默认值 | 说明                                                 |
| ------------------ | ------ | ---------------------------------------------------- |
| `concurrency`      | `6`    | 最大并发处理数                                       |
| `maxRetries`       | `3`    | 单个分片失败后的最大重试次数（不含首次）             |
| `retryBaseDelayMs` | `500`  | 指数退避基准时间                                     |
| `retryMaxDelayMs`  | `5000` | 退避时间上限                                         |
| `onProgress`       | —      | `(completed, total) => void`，每完成一个分片回调一次 |

`ProcessController`：

```ts
interface ProcessController {
  pause: () => void
  resume: () => void
  cancel: () => void
  readonly promise: Promise<void>
}
```

- `pause` 是 **协作式** 的：已开始的处理函数会继续运行直到它返回；之后任何新的重试或新分片会等待 `resume`。
- `cancel` 会 `abort` 信号并让正在等待的任务立即抛出 `CancellationError`；正在执行的 `processor` 应自行响应 `signal.aborted`。

### `collectChunks(chunkPromises)`

```ts
function collectChunks(chunkPromises: Promise<Chunk>[]): Promise<Chunk[]>
```

等待全部分片解析，按索引顺序返回。

### `calculateFileHash(chunkPromises)`

```ts
function calculateFileHash(chunkPromises: Promise<Chunk>[]): Promise<string>
```

按顺序读取每个分片的二进制数据，增量计算并返回完整文件的 MD5。结果与服务端对原始文件执行 `md5sum` **一致**。

> 注意：这会触发对每个分片的 `arrayBuffer()` 读取。大文件上传完成后不再需要 MD5 时可以省略本步骤。

### 类型

```ts
interface Chunk {
  blob: Blob // 分片数据
  hash: string // 该分片的 MD5
  index: number // 0 起始的分片序号
  start: number // 起始字节（含）
  end: number // 结束字节（不含）
}
```

### 错误类型

| 类                    | 何时抛出                                                                          |
| --------------------- | --------------------------------------------------------------------------------- |
| `CancellationError`   | 调用 `cancel()` 后，待执行任务从 `processChunks` 抛出                             |
| `RetryExhaustedError` | 单个分片重试次数耗尽；`error.cause` 是最后一次错误，`error.attempts` 是总尝试次数 |

判断方式：`error instanceof CancellationError`，避免依赖错误消息字符串。

## 浏览器兼容性

依赖 Web Workers、`AbortSignal`、`Blob.arrayBuffer()`：

- Chrome ≥ 66
- Firefox ≥ 57
- Safari ≥ 12.1
- Edge ≥ 16

## 许可证

[MIT](./LICENSE)
