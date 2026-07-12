import {
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import type { AbstractFile, Files } from "@peerbit/please-lib";

export const DEFAULT_REMOTE_ROOT_CONFIRMATION_TIMEOUT_MS = 3_000;

export type RemoteRootConfirmation =
    | {
          status: "present";
          root: AbstractFile;
      }
    | {
          status: "missing";
      }
    | {
          status: "unknown";
          diagnostic?: string;
      };

const getDiagnostic = (error: unknown) => {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    if (typeof error === "string") {
        return error;
    }
    return undefined;
};

const getModified = (root: AbstractFile) => {
    const modified = (
        root as AbstractFile & {
            __context?: { modified?: unknown };
        }
    ).__context?.modified;
    return typeof modified === "bigint" ? modified : undefined;
};

const preferNewerRoot = (current: AbstractFile, candidate: AbstractFile) => {
    const currentModified = getModified(current);
    const candidateModified = getModified(candidate);
    if (candidateModified == null) {
        return current;
    }
    if (currentModified == null || candidateModified > currentModified) {
        return candidate;
    }
    return current;
};

/**
 * Confirms an exact remote root against every currently known remote
 * replicator. A missing response is deliberately kept distinct from a
 * successful lookup that found no document.
 */
export const confirmRemoteRoot = async (
    program: Files,
    id: string,
    signal: AbortSignal,
    timeoutMs = DEFAULT_REMOTE_ROOT_CONFIRMATION_TIMEOUT_MS
): Promise<RemoteRootConfirmation> => {
    if (signal.aborted) {
        return {
            status: "unknown",
            diagnostic: "Remote root confirmation was aborted",
        };
    }

    try {
        const hints = await program.getReadPeerHints();
        if (!hints?.length) {
            return {
                status: "unknown",
                diagnostic: "No remote read peers are available",
            };
        }

        signal.throwIfAborted();
        const from = [...hints];
        // Published declarations lag runtime support for `from`. Keeping the
        // compatible options in a variable avoids an excess-property failure.
        const remote = {
            from,
            replicate: false,
            timeout: timeoutMs,
            throwOnMissing: true,
            retryMissingResponses: false,
            strategy: "fallback" as const,
        };
        const candidates = (await program.files.index.search(
            new SearchRequest({
                query: new StringMatch({
                    key: "id",
                    value: id,
                    caseInsensitive: false,
                    method: StringMatchMethod.exact,
                }),
                fetch: 0xffffffff,
            }),
            {
                local: false,
                signal,
                remote,
            }
        )) as AbstractFile[];
        signal.throwIfAborted();

        if (candidates.length === 0) {
            return { status: "missing" };
        }
        const roots = candidates.filter(
            (candidate) => candidate.id === id && !candidate.parentId
        );
        if (roots.length === 0) {
            return {
                status: "unknown",
                diagnostic: "Exact root search returned no valid root document",
            };
        }
        const candidate = roots.slice(1).reduce(preferNewerRoot, roots[0]);
        return { status: "present", root: candidate };
    } catch (error) {
        return {
            status: "unknown",
            diagnostic: getDiagnostic(error),
        };
    }
};
