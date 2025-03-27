import { StaticContent } from "@dao-xyz/social";

export type ChangeCallback = (
    newContent: StaticContent["content"],
    options?: { save: boolean }
) => void | Promise<void>;
