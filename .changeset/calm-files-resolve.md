---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add operator-grade conflict inspection and resolution commands. The CLI now
lists content and naming conflicts in stable JSON, resolves selected content
heads and explicit namespace actions from full write-ready replicas, and
optionally reports both conflict classes through machine-readable status
output. Naming resolution adds an observed-topology fence, and repeated delete
actions now acknowledge newly visible delete-vs-edit content heads instead of
quiescing too early. Naming actions revalidate the complete observed conflict
topology, while status and listing JSON distinguish verified snapshot coverage
from off, observer, plain-join, and changing partial views. Guarded delete and
restore actions no longer absorb content heads that arrive after their final
validated snapshot.
