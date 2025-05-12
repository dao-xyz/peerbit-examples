// utils/navBackToParent.ts
import { useNavigate } from "react-router";
import type { Canvas as CanvasDB } from "@giga-app/interface";
import { useLeaveSnapshotFn } from "./reply/feedRestoration";
import { getCanvasPath } from "../routes";
import { peekPrevPath } from "../useNavHistory";

/**
 * Returns a callback that:
 *  1. looks at window.history to see if the immediate previous entry *is*
 *     the given parent canvas;
 *  2. if yes → navigate(-1)  (real history back, existing snapshot is re-used)
 *  3. else → calls leaveSnapshot() and push()es the parent route.
 */
export function useBackToParent(parent?: CanvasDB) {
    const nav = useNavigate();
    const leaveSnapshot = useLeaveSnapshotFn();

    return () => {
        if (!parent) {
            throw new Error("Missing parent canvas");
        }
        const parentPath = getCanvasPath(parent);

        const prevPath = peekPrevPath(); // one cheap array lookup
        // look at both paths without query params
        const prevPathNoQuery = prevPath?.split("?")[0];
        const parentPathNoQuery = parentPath.split("?")[0];
        if (prevPathNoQuery === parentPathNoQuery) {
            nav(-1); // real back -> snapshot already exists
        } else {
            leaveSnapshot(parent); // capture where we are *now*
            nav(parentPath); // push new entry
        }
    };
}
