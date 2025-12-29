import fs from "fs/promises";
import path from "path";

export async function readJsonFile<T>(
    filePath: string,
    defaultValue: T
): Promise<T> {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw) as T;
    } catch (error: any) {
        if (error?.code === "ENOENT") return defaultValue;
        throw error;
    }
}

export async function writeJsonFile<T>(filePath: string, value: T) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
}
