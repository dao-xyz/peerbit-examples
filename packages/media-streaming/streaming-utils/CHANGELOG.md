# @peerbit/media-streaming

## 2.0.2

### Patch Changes

- a4cfd4e: Make media seeking fail closed when the canonical origin cannot prove a page,
  rather than treating partial or still-syncing relay and local caches as
  complete. Bound retries and pagination, align finite-track endpoints, and make
  abort and iterator cleanup deterministic.
- ed08363: Deliver newly appended media chunks to current live subscribers when `Track.put` uses its default replicator target.
- 9dd6b92: Reference-count shared media tracks and dynamically opened streams, fence final
  teardown against concurrent consumer admission, cancel superseded playback
  reads, coalesce bursty monitoring refreshes, and retain failed cleanup for exact
  retries.

    Fail closed when the canonical media origin disappears, bound route probes,
    resume recorded playback from the last callback that actually committed, and
    pause truthfully when a progress callback fails so an explicit replay can retry
    recorded work. Finalize empty and open-ended recordings only after track
    metadata is exhausted, without losing future segments or duplicating frames.
    Publish terminal empty track state from the last delivered consumer view,
    detach Promise returns from the synchronous close-notification contract, and
    re-arm monitor scans when a refresh lands in their completion handoff. Retire
    an ended live track when its final progress callback drains while exact listener
    cleanup is still in flight, without racing a duplicate close.

    Correct the published packages' direct runtime dependencies, require Node 22 or
    newer consistently with their clean-consumer dependency closure, and make the
    browser frontends resolve one cryptographic key-class identity across the Peerbit
    client and media programs. Keep music-library query subscriptions stable across
    React renders so startup does not churn closed iterators. Export the video
    replicator API from its public package root and verify that entry point through
    engine-strict isolated tarball installs.

## 2.0.1

### Patch Changes

- Bump Peerbit

## 2.0.0

### Major Changes

- Bump peerbit @peerbit/document v12. Change of wiretypes for indexed types

## 1.0.0

### Major Changes

- Update for to reflect upstream Peerbit version

## 0.0.6

### Patch Changes

- Bump
