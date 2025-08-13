# FluxForge

[![npm version](https://img.shields.io/npm/v/fluxforge.svg)](https://www.npmjs.com/package/fluxforge)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Enterprise-grade file chunking & concurrent processing library with Web Workers, automatic retry, real-time progress tracking, and MD5 integrity validation for modern browsers. Perfect for large file uploads, streaming, and data processing pipelines.

English | [简体中文](README-zh-CN.md)

---

## Live Demo

[Live Demo](https://joygqz.github.io/fluxforge/)

---

## Key Features

### 🚀 High-Performance Architecture

- **Multi-threaded Processing**: Leverages Web Workers for true parallel chunking, maximizing CPU utilization
- **Zero-Copy Streaming**: Memory-efficient chunk processing without loading entire files into memory
- **Intelligent Resource Management**: Auto-detects hardware capabilities and optimizes thread allocation

### 🛡️ Enterprise-Grade Reliability

- **Automatic Retry Logic**: Built-in exponential backoff strategy for transient failures
- **Task Lifecycle Management**: Comprehensive pause/resume/cancel controls with graceful cleanup
- **Signal-Based Cancellation**: AbortSignal integration for immediate task termination
- **Type-Safe API**: 100% TypeScript with strict type checking and comprehensive interfaces

### 🔧 Advanced Task Scheduling

- **Configurable Concurrency**: Fine-tune parallel execution limits based on system constraints
- **Real-time Progress Tracking**: Granular progress callbacks for UI responsiveness
- **Backpressure Handling**: Intelligent queuing prevents memory overflow in high-throughput scenarios

### 🔐 Data Integrity

- **Chunk-level MD5 Hashing**: Per-chunk integrity validation using SparkMD5
- **File-level Hash Computation**: Aggregate hash calculation for complete file verification
- **Deterministic Processing**: Guaranteed chunk order preservation across parallel operations

---

## Installation

```bash
npm i fluxforge
```

---

## Quick Start

```typescript
import { calculateFileHash, chunkFile, processChunks } from 'fluxforge'

// Create chunk promises with optimal settings
const chunkPromises = chunkFile(file, {
  chunkSize: 4 * 1024 * 1024 // 4MB chunks for optimal performance
})

// Process chunks with advanced configuration
const controller = processChunks(
  chunkPromises,
  async (chunk, signal) => {
    // Handle cancellation gracefully
    if (signal.aborted)
      throw new Error('Operation cancelled')

    // Your business logic here (upload, transform, etc.)
    await uploadChunk(chunk.blob, chunk.index)

    // Optional: Listen for cancellation during long operations
    signal.addEventListener('abort', () => {
      // Cleanup resources, cancel network requests, etc.
    })
  },
  {
    concurrency: 6, // Optimal for most scenarios
    onProgress: (completed, total) => {
      const percentage = Math.round((completed / total) * 100)
      updateProgressBar(percentage)
    }
  }
)

// Advanced task control
controller.pause() // Gracefully pause all processing
controller.resume() // Resume from where it left off
controller.cancel() // Immediately abort all operations

// Wait for completion
try {
  await controller.promise
  console.log('All chunks processed successfully')
}
catch (error) {
  if (error.message === 'Task cancelled') {
    console.log('Processing was cancelled by user')
  }
  else {
    console.error('Processing failed:', error)
  }
}

// Verify file integrity
const fileHash = await calculateFileHash(chunkPromises)
console.log('File MD5:', fileHash)
```

---

## API Reference

### Core Functions

#### `chunkFile(file: File, options?: Options): Promise<Chunk>[]`

Splits a file into an array of chunk promises, each processed in parallel by Web Workers.

**Parameters:**

- `file`: The File object to be chunked
- `options.chunkSize`: Chunk size in bytes (default: `Math.min(1024 * 1024, file.size)`)

**Returns:** Array of promises that resolve to `Chunk` objects

**Performance Notes:**

- Automatically determines optimal worker count based on `navigator.hardwareConcurrency`
- Workers are automatically terminated when all chunks are processed
- Chunk order is guaranteed despite parallel processing

#### `processChunks(chunkPromises, processor, options?): ProcessController`

Processes chunk promises with configurable concurrency and automatic retry logic.

**Parameters:**

- `chunkPromises`: Array of chunk promises from `chunkFile()`
- `processor`: Function that processes each chunk
- `options.concurrency`: Max concurrent processors (default: 6)
- `options.onProgress`: Progress callback function

**Returns:** `ProcessController` with pause/resume/cancel capabilities

**Processor Function:**

```typescript
type ChunkProcessor = (chunk: Chunk, signal: AbortSignal) => void | Promise<void>
```

The processor receives:

- `chunk`: The resolved chunk with blob data and metadata
- `signal`: AbortSignal for cancellation handling

#### `collectChunks(chunkPromises: Promise<Chunk>[]): Promise<Chunk[]>`

Waits for all chunk promises to resolve and returns them in original order.

#### `calculateFileHash(chunkPromises: Promise<Chunk>[]): Promise<string>`

Computes the MD5 hash of the entire file by aggregating individual chunk hashes.

### Types

```typescript
interface Chunk {
  blob: Blob // The chunk data
  hash: string // MD5 hash of this chunk
  index: number // Zero-based chunk index
  start: number // Start byte position in file
  end: number // End byte position in file
}

interface Options {
  chunkSize?: number // Chunk size in bytes
}

interface ProcessOptions {
  concurrency?: number // Max concurrent processors
  onProgress?: (completed: number, total: number) => void
}

interface ProcessController {
  pause: () => void // Pause processing
  resume: () => void // Resume processing
  cancel: () => void // Cancel all processing
  promise: Promise<void> // Completion promise
}
```

---

## Performance Considerations

### Optimal Chunk Sizes

- **Small files (<10MB)**: Use default chunk size for simplicity
- **Medium files (10MB-1GB)**: 2-8MB chunks for balanced memory/performance
- **Large files (>1GB)**: 8-16MB chunks to minimize overhead

### Concurrency Guidelines

- **CPU-intensive processing**: Use `navigator.hardwareConcurrency`
- **Network operations**: 3-6 concurrent requests to avoid overwhelming servers
- **Memory-constrained environments**: Reduce concurrency to prevent OOM

### Memory Management

- The library uses streaming processing to minimize memory footprint
- Only active chunks are kept in memory
- Automatic garbage collection of processed chunks

---

## Error Handling

The library provides robust error handling with automatic retry mechanisms:

1. **Transient Failures**: Automatically retried with exponential backoff
2. **Cancellation**: Clean termination via AbortSignal
3. **Fatal Errors**: Immediate failure propagation

```typescript
try {
  await controller.promise
}
catch (error) {
  if (error.message === 'Task cancelled') {
    // User-initiated cancellation
  }
  else {
    // Actual processing error after all retries exhausted
  }
}
```

---

## Browser Compatibility

- **Chrome 66+** (Web Workers, AbortSignal)
- **Firefox 57+** (Web Workers, AbortSignal)
- **Safari 12.1+** (Web Workers support)
- **Edge 16+** (Chromium-based)

---

## License

MIT License - see [LICENSE](LICENSE) for details.
