import {
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
    FilterModel,
} from "@giga-app/interface";
import { SearchRequest } from "@peerbit/document-interface";
import { Sort, SortDirection } from "@peerbit/indexer-interface";

export type DefaultViewType = "new" | "old" | "best" | "chat" | "gallery";

export const ALL_DEFAULT_FILTERS: FilterModel[] = [
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
        id: "chat",
        name: "Chat",
        settings: {
            layout: "list",
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
                        key: ["__context", "created"],
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
        id: "gallery",
        name: "Gallery",
        settings: {
            layout: "grid",
            paginationLimit: 10,
            showAuthorInfo: false,
            classNameContainer: "flex flex-row flex-wrap !gap-2",
            classNameReply: "w-fit max-w-40 max-h-40 overflow-hidden",
        },
    },
    /*  {
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
     }, */
    {
        query: (canvas) =>
            new SearchRequest({
                query: getRepliesQuery(canvas),
                sort: new Sort({
                    key: ["__context", "created"],
                    direction: SortDirection.DESC,
                }),
            }),
        id: "recent",
        name: "Recent",
        settings: {
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
                    direction: SortDirection.DESC,
                }),
            }),
        id: "new",
        name: "New",
        settings: {
            layout: "list",
            paginationLimit: 10,
            showAuthorInfo: true,
        },
    },

    /* {
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
    }, */
];
