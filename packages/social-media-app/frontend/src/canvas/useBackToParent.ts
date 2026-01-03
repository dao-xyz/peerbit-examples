// utils/navBackToParent.ts
import { useNavigate } from "react-router";
import type { Canvas as CanvasDB } from "@giga-app/interface";
import { getCanvasPath } from "../routes";
import { peekPrevPaths } from "../useNavHistory";

export function useBackToParent(parent?: CanvasDB) {
    const nav = useNavigate();

    return () => {
        if (!parent) {
            throw new Error("Missing parent canvas");
        }
        const parentPath = getCanvasPath(parent);
        const parentPathNoQuery = parentPath.split("?")[0];
        const parentIsRoot = (() => {
            const maybeIndexed = parent as any;
            const p = maybeIndexed?.__indexed?.path;
            return Array.isArray(p) && p.length === 0;
        })();

        const maxHistorySearch = 50;
        for (let i = 0; i < maxHistorySearch; i++) {
            const prevPath = peekPrevPaths(i); // one cheap array lookup
            // look at both paths without query params
            const prevPathNoQuery = prevPath?.split("?")[0];

            // Root can be represented as either `/` or `/c/:id` depending on entrypoint.
            const matchesParent =
                prevPathNoQuery === parentPathNoQuery ||
                (parentIsRoot && prevPathNoQuery === "/");

            if (matchesParent) {
                // real back -> snapshot already exists
                nav(-i); // go back to the parent
                return;
            }
        }

        nav(parentPath); // push new entry
    };
}
