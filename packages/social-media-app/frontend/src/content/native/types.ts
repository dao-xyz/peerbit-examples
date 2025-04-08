import { StaticContent } from "@giga-app/interface";

export type ChangeCallback = (
    newContent: StaticContent | StaticContent[],
    options?: { save: boolean }
) => void | Promise<void>;
