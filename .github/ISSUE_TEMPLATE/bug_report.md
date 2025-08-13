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
- fluxforge version: [e.g. 0.0.1]
- Node.js version (if using in Node): [e.g. 20.0.0]
- File size being processed: [e.g. 10MB]
- Chunk size used: [e.g. 1MB]
- Hardware concurrency: [e.g. 4 cores]

**Code Sample**

```javascript
// Please provide a minimal code sample that reproduces the issue
import { calculateFileHash, chunkFile, collectChunks, processChunks } from 'fluxforge'

// Your code here...
// Example:
// const chunkPromises = chunkFile(file, { chunkSize: 2 * 1024 * 1024 })
// await processChunks(chunkPromises, (chunk, completed, total) => { ... })
```

**Additional context**
Add any other context about the problem here.
