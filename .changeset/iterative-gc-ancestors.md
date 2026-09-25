---
"@peerbit/shared-fs": patch
---

Plan garbage collection over deep version and naming histories without
recursion. The common-ancestor walk used one stack frame per history level and
threw `RangeError` at a few thousand levels, and it kept a full ancestor set for
every document. It now walks each head's ancestors with an explicit stack.
Retirement decisions for acyclic histories are unchanged.
