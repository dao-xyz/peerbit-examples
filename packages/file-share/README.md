# File share app

An example how one can use a Document store to store files.

## Library
In the library folder you can find all code that is handling the file data.

## Frontend 
<img src="./demo-frontend.gif" width="600" />

In the frontend folder you can find a React application using the library as a dependency.

The hosted application is available at [files.apps.peerbit.org](https://files.apps.peerbit.org).

### Transfer benchmark

The `File Share Benchmarks` workflow uploads deterministic AES-CTR fixture
bytes and requires matching source, manifest, library-stream SHA-256, and sink
CRC-32 evidence. Its default `hash-only` download sink computes CRC-32 in the
reader page and discards each chunk immediately. This is the primary Peerbit
measurement because it does not add one loopback HTTP request or filesystem
write for every 512 KiB chunk.

Choose `opfs` to measure the same transfer with browser-native Origin Private
File System persistence. `node-file` is retained as a diagnostic comparison
with the older loopback HTTP sink. Compare sinks in separate workflow runs; a
second read in the same browser would measure a warmed reader.

Each result keeps click-to-sink timing but reports sink-exclusive stream time as
the primary download throughput. It also records awaited sink-write time,
per-source chunk and byte totals, chunk demand-wait p50/p95/p99/max and long-wait
counts, reader and writer JS heap, Chromium RSS grouped by process role, Peerbit
logical log usage, and `navigator.storage.estimate()` snapshots. Browser origin
storage is an estimate (and includes the OPFS output for the `opfs` sink), while
renderer RSS cannot be assigned reliably to one page; the result schema labels
both limitations explicitly.

For a local focused run after building `@peerbit/please-lib`:

```sh
cd packages/file-share/frontend
PW_BENCH=1 PW_BENCH_SCENARIO=local PW_READER_COHORT=live-replicator \
  PW_DOWNLOAD_SINK=hash-only PW_FILE_MB=256 \
  npx playwright test -c playwright.config.ts tests/transfer.bench.e2e.spec.ts \
  --project chromium
```

## CLI

<img src="./demo-cli.gif" width="600" />

There is a CLI application inside [./cli](./cli), that allows you to do the basic functionality.

By default the CLI stores its Peerbit state in `~/peerbit-file-share`, so uploaded files can be resumed from a persistent local directory. Pass `--directory null` if you want to run it in ephemeral mode instead.

Install from remote: 

```sh
npm install @peerbit/please
```

Now you can do 

```sh
please put FILE 
```

Keep the `please put ...` process running while you want to seed the file.

and 

```sh
please get HASH [OPTIONAL_SAVE_PATH]
```

e.g. 

```sh
please put test.txt 
```

```sh
please get HASH ./some-folder
```


### Run CLI locally
To run it locally:

First go to the root folder of the examples repo and build it

```
pnpm build
```

Then go back to the [./cli](./cli) folder and now you can do: 

```node  ./cli/lib/esm/bin.js``` instead of ```please``` to invoke the cli. 

You can dial a local peer by passing its address with `--peer`.
The older `--bootstrap` and `--relay` flags are still accepted as aliases, but the CLI now dials the peer directly and lets Peerbit discover shard roots automatically.
