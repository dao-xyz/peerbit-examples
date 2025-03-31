import { StaticContent } from "@giga-app/interface";

export type ChangeCallback = (
    newContent: StaticContent["content"],
    options?: { save: boolean }
) => void | Promise<void>;
