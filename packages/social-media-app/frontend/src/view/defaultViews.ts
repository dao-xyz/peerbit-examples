import {
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@giga-app/interface";
import { SearchRequest } from "@peerbit/document-interface";
import { Sort, SortDirection } from "@peerbit/indexer-interface";

export type DefaultViewType =
    | "new"
    | "old"
    | "best"
    | "chat"
    | "gallery"
    | "comments";

export const ALL_DEFAULT_VIEWS: ViewModel[] = [
    {
        query: (canvas) =>
            new SearchRequest({
                query: getRepliesQuery(canvas),
                sort: [
                    new Sort({
                        key: ["__context", "created"],
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
        id: "chat",
        name: "Chat",
        settings: {
            layout: "list",
            focus: "last",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },

    {
        query: (canvas) =>
            new SearchRequest({
                query: getImmediateRepliesQuery(canvas),
                sort: [
                    new Sort({
                        key: ["replies"],
                        direction: SortDirection.DESC,
                    }),
                    new Sort({
                        key: ["__context", "created"],
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
        id: "best",
        name: "Best",
        settings: {
            layout: "list",
            focus: "first",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },
    {
        query: (canvas) =>
            new SearchRequest({
                query: getImmediateRepliesQuery(canvas),
                sort: new Sort({
                    key: ["__context", "created"],
                    direction: SortDirection.DESC,
                }),
            }),
        id: "new",
        name: "New",
        settings: {
            focus: "first",
            layout: "list",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },

    {
        query: (canvas) =>
            new SearchRequest({
                query: getImmediateRepliesQuery(canvas),
                sort: new Sort({
                    key: ["__context", "created"],
                    direction: SortDirection.ASC,
                }),
            }),
        id: "old",
        name: "Old",
        settings: {
            focus: "first",
            layout: "list",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },

    {
        query: (canvas) =>
            new SearchRequest({
                query: getRepliesQuery(canvas),
                sort: [
                    new Sort({
                        key: ["__context", "created"],
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
        id: "gallery",
        name: "Gallery",
        settings: {
            focus: "first",
            layout: "grid",
            paginationLimit: 10,
            showAuthorInfo: false,
            classNameContainer: "flex flex-row flex-wrap !gap-2",
            classNameReply: "w-fit max-w-40 max-h-40 overflow-hidden",
        },
    },

    {
        query: (canvas) =>
            new SearchRequest({
                query: getRepliesQuery(canvas),
                sort: [
                    new Sort({
                        key: ["__context", "created"],
                        direction: SortDirection.ASC,
                    }),
                ],
            }),
        id: "comments",
        name: "Comments",
        settings: {
            focus: "first",
            layout: "list",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },
];

// Define the structure for each View Model.
export interface ViewSettings {
    // These are placeholders, and you can expand them as necessary.
    layout: "grid" | "list" | "single";
    focus: "first" | "last";
    paginationLimit?: number; // Define how many replies to show per page.
    showAuthorInfo?: boolean; // Whether or not to show author information.
    classNameContainer?: string; // Optional class name for the container.
    classNameReply?: string; // Optional class name for each reply.
}

export interface ViewModel {
    id: string; // Key to identify the view.
    name: string; // Human-readable name for the view.
    query: (from: Canvas) => SearchRequest; // The query associated with this view.
    settings: ViewSettings; // Extra settings for customization.
}
