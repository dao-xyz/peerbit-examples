// utils/navBackToParent.ts
import { useNavigate } from "react-router";
import type { Canvas as CanvasDB } from "@giga-app/interface";
import { useLeaveSnapshotFn } from "./feed/feedRestoration";
import { getCanvasPath } from "../routes";
import { peekPrevPaths, consumePaths } from "../useNavHistory";

export function useBackToParent(parent?: CanvasDB) {
    const nav = useNavigate();
    const leaveSnapshot = useLeaveSnapshotFn();

    return () => {
        if (!parent) {
            throw new Error("Missing parent canvas");
        }
        const parentPath = getCanvasPath(parent);
        const parentPathNoQuery = parentPath.split("?")[0];

        let maxHistorySearch = 10;
        for (let i = 0; i < maxHistorySearch; i++) {
            const prevPath = peekPrevPaths(i); // one cheap array lookup
            // look at both paths without query params
            const prevPathNoQuery = prevPath?.split("?")[0];

            if (prevPathNoQuery === parentPathNoQuery) {
                // real back -> snapshot already exists
                consumePaths(i); // remove the history entries we just skipped
                nav(-i); // go back to the parent
                console.log("NAV TO", -1 - i);
                return;
            }
        }

        leaveSnapshot(parent); // capture where we are *now*
        nav(parentPath); // push new entry
    };
}
