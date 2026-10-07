---
"@peerbit/shared-fs-cli": patch
---

The cross-OS interop script (`cross-os-interop`) keeps every peer running until every peer has read every file, then exits seed-last. Before, a peer left as soon as it had read all files. When another peer was still missing its file, nobody delivered it: shared-log only pushes an entry from its author, so the waiting peer timed out (upstream U-53/U-54). On a timeout the script now prints each peer's connections, topic subscribers, replicators with reachability, log heads per author, sync and bootstrap state, and which machine files it has.
