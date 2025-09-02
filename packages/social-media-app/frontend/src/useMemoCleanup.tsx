import { useMemo, useEffect } from "react";

/**
 * A hook that memoizes a resource and automatically cleans it up
 * when dependencies change or the component unmounts.
 *
 * @param factory - Function that creates the resource.
 * @param deps - Dependency array that determines when to recreate the resource.
 * @returns The created resource.
 */
export function useMemoCleanup<T>(
    factory: () => T,
    deps: React.DependencyList,
    cleanup?: (resource: T) => void
): T {
    const resource = useMemo(factory, deps);

    useEffect(() => {
        return () => {
            cleanup?.(resource);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resource]);

    return resource;
}
