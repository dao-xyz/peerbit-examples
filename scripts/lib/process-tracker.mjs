import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const processDir = path.join(repoRoot, "tmp", "processes");

function readState(filePath) {
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch (_error) {
    return {};
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export class ProcessTracker {
  constructor(fileName) {
    this.filePath = path.join(processDir, fileName);
    this.state = readState(this.filePath);
  }

  track(key, payload) {
    this.state[key] = {
      ...payload,
      recordedAt: new Date().toISOString()
    };
    writeState(this.filePath, this.state);
  }

  untrack(key) {
    if (!(key in this.state)) {
      return;
    }
    delete this.state[key];
    writeState(this.filePath, this.state);
  }

  list() {
    return { ...this.state };
  }
}
