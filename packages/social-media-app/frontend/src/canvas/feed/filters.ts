import {
    NATIVE_IMAGE_APP_URL,
    NATIVE_PARTIAL_IMAGE_APP_URL,
    NATIVE_TEXT_APP_URL,
} from "@giga-app/interface";

export type TimeFilterType = "24h" | "7d" | "30d" | "all";
export type TypeFilterType = "image" | "text" | "all";

type NamedFilter<T extends TimeFilterType | TypeFilterType> = {
    key: T;
    name: string;
};

export type TypeFilter = NamedFilter<TypeFilterType> & { types?: string[] };
export const TYPE_FILTERS: Map<string, TypeFilter> = new Map([
    [
        "image",
        {
            key: "image",
            types: [NATIVE_IMAGE_APP_URL, NATIVE_PARTIAL_IMAGE_APP_URL],
            name: "Images",
        },
    ],
    ["text", { key: "text", types: [NATIVE_TEXT_APP_URL], name: "Text" }],
    ["all", { key: "all", name: "All types" }],
]);

export type TimeFilter = NamedFilter<TimeFilterType>;
export const TIME_FILTERS: Map<string, TimeFilter> = new Map([
    ["24h", { key: "24h", name: "Last 24 hours" }],
    ["7d", { key: "7d", name: "Last 7 days" }],
    ["30d", { key: "30d", name: "Last 30 days" }],
    ["all", { key: "all", name: "All time" }],
]);

export const DEFAULT_TIME_FILTER: TimeFilterType = "all";
export const DEFAULT_TYPE_FILTER: TypeFilterType = "all";
