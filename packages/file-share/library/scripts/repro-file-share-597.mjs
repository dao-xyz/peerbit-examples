import crypto from "node:crypto";
import { Peerbit } from "peerbit";
import { Files } from "@peerbit/please-lib";

const FILE_MB = Number(process.env.FILE_MB ?? 100);
const STORAGE_MB = Number(process.env.STORAGE_MB ?? 8);
const FILE_BYTES = Math.floor(FILE_MB * 1e6);
const STORAGE_BYTES = Math.floor(STORAGE_MB * 1e6);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 120_000);
const FORMATION_TIMEOUT_MS = Number(process.env.FORMATION_TIMEOUT_MS ?? 60_000);
const OBSERVE_AFTER_SYNC_MS = Number(process.env.OBSERVE_AFTER_SYNC_MS ?? 20_000);
const DO_FETCH = process.env.DO_FETCH !== "0";
const READER_REPLICATE = process.env.READER_REPLICATE !== "0";

const log = (...args) => {
  console.log(new Date().toISOString(), ...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, timeoutMs, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const waitForResolved = async (fn, { timeout = 60_000, delayInterval = 1000 } = {}) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await sleep(delayInterval);
    }
  }
  throw new Error(
    `waitForResolved timed out after ${timeout}ms` +
      (lastError ? ` (lastError=${lastError?.message || lastError})` : "")
  );
};

const startSampler = (files, label) => {
  let max = 0;
  let ticks = 0;
  const interval = setInterval(async () => {
    if (files.closed) return;
    try {
      const m = await files.files.log.getMemoryUsage();
      ticks++;
      if (m > max) {
        max = m;
        log(`${label} memory peak`, `${(m / 1e6).toFixed(2)} MB`);
      }
    } catch {
      // ignore sampling errors during shutdown races
    }
  }, 1000);

  return async () => {
    clearInterval(interval);
    let current = 0;
    try {
      current = await files.files.log.getMemoryUsage();
    } catch {}
    return { max, current, ticks };
  };
};

const waitForWriterVisible = async (reader, writerPeer) => {
  await withTimeout(
    reader.files.log.waitForReplicator(writerPeer.identity.publicKey),
    FORMATION_TIMEOUT_MS,
    "waitForReplicator(writer)"
  );
};

const runScenario = async ({ name, connectBeforeUpload, payload }) => {
  let writerPeer;
  let readerPeer;

  log("scenario:start", { name, connectBeforeUpload, fileMB: FILE_MB, storageMB: STORAGE_MB });

  try {
    writerPeer = await Peerbit.create();
    readerPeer = await Peerbit.create();
    const writerStore = await writerPeer.open(new Files());
    const fileName = `${name}-${Date.now()}.bin`;

    let readerStore;
    if (connectBeforeUpload) {
      await writerPeer.dial(readerPeer);
      log(name, "dialed before upload");

      readerStore = await readerPeer.open(writerStore.address);
      await waitForWriterVisible(readerStore, writerPeer);
      log(name, "writer visible before upload");

      await writerStore.add(fileName, payload);
      log(name, "upload complete while connected", { bytes: payload.length });
    } else {
      await writerStore.add(fileName, payload);
      log(name, "upload complete before dial", { bytes: payload.length });

      await writerPeer.dial(readerPeer);
      log(name, "dialed after upload");

      readerStore = await readerPeer.open(writerStore.address);
    }

    // Mirror frontend role update: reader can be storage-limited replicator or observer.
    await readerStore.files.log.replicate(false);
    if (READER_REPLICATE) {
      await readerStore.files.log.replicate({
        limits: {
          cpu: { max: 1 },
          storage: STORAGE_BYTES,
        },
      });
    }

    const stopSampling = startSampler(readerStore, `${name}/reader`);

    await waitForWriterVisible(readerStore, writerPeer);
    log(name, "writer visible for fetch");

    await waitForResolved(
      async () => {
        const listed = await readerStore.list();
        if (!listed.some((f) => f.name === fileName)) {
          throw new Error("file metadata not visible yet");
        }
      },
      { timeout: FETCH_TIMEOUT_MS, delayInterval: 2000 }
    );

    let fetchError = null;
    let fetchedBytes = 0;
    if (DO_FETCH) {
      try {
        const got = await withTimeout(
          readerStore.getByName(fileName, { as: "joined" }),
          FETCH_TIMEOUT_MS,
          "getByName(file)"
        );
        fetchedBytes = got?.bytes?.byteLength ?? 0;
        if (!got || fetchedBytes !== payload.length) {
          throw new Error(`Unexpected fetch result bytes=${fetchedBytes} expected=${payload.length}`);
        }
        log(name, "fetch succeeded", { fetchedBytes });
      } catch (error) {
        fetchError = String(error?.stack || error?.message || error);
        log(name, "fetch failed", fetchError);
      }
    } else {
      log(name, "fetch skipped; observing post-sync behavior", { observeMs: OBSERVE_AFTER_SYNC_MS });
    }

    await sleep(OBSERVE_AFTER_SYNC_MS);

    const mem = await stopSampling();
    const localCount = await readerStore.files.index.getSize();
    log("scenario:end", {
      name,
      fetchError,
      fetchedBytes,
      readerLocalDocCount: localCount,
      readerMemoryPeakMB: Number((mem.max / 1e6).toFixed(2)),
      readerMemoryCurrentMB: Number((mem.current / 1e6).toFixed(2)),
      sampleTicks: mem.ticks,
    });

    return { name, fetchError, fetchedBytes, memoryPeak: mem.max, memoryCurrent: mem.current, localCount };
  } finally {
    await Promise.allSettled([
      writerPeer?.stop(),
      readerPeer?.stop(),
    ]);
  }
};

const main = async () => {
  log("repro:config", { FILE_MB, STORAGE_MB, FETCH_TIMEOUT_MS, FORMATION_TIMEOUT_MS, OBSERVE_AFTER_SYNC_MS, DO_FETCH, READER_REPLICATE });
  const payload = crypto.randomBytes(FILE_BYTES);
  log("repro:payload-ready", { bytes: payload.length });

  const before = await runScenario({ name: "connected-before-upload", connectBeforeUpload: true, payload });
  await sleep(2_000);
  const after = await runScenario({ name: "connect-after-upload", connectBeforeUpload: false, payload });

  log("repro:summary", {
    connectedBefore: {
      fetchError: before.fetchError,
      fetchedBytes: before.fetchedBytes,
      localCount: before.localCount,
      memoryPeakMB: Number((before.memoryPeak / 1e6).toFixed(2)),
    },
    connectAfter: {
      fetchError: after.fetchError,
      fetchedBytes: after.fetchedBytes,
      localCount: after.localCount,
      memoryPeakMB: Number((after.memoryPeak / 1e6).toFixed(2)),
    },
  });
};

main().catch((error) => {
  console.error(new Date().toISOString(), "repro:fatal", error?.stack || error);
  process.exitCode = 1;
});
