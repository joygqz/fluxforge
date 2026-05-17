---
name: Bug report
about: Create a report to help us improve
title: '[BUG] '
labels: bug
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:

1. Code example or steps
2. Expected vs actual behavior
3. Error messages (if any)

**Environment**

- Browser: [e.g. Chrome 120, Firefox 121, Safari 16]
- fluxforge version: [e.g. 0.0.7]
- File size being processed: [e.g. 10MB]
- Chunk size used: [e.g. 1MB]
- Hardware concurrency: [e.g. 4 cores]

**Code Sample**

```ts
import { calculateFileHash, chunkFile, collectChunks, processChunks } from 'fluxforge'

const chunkPromises = chunkFile(file, { chunkSize: 2 * 1024 * 1024 })
const controller = processChunks(
  chunkPromises,
  async (chunk, signal) => {
    // your processor here
  },
  { concurrency: 6, onProgress: (done, total) => { /* ... */ } },
)
await controller.promise
```

**Additional context**
Add any other context about the problem here.
