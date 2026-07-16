import { MediaStreamDB } from "@peerbit/media-streaming";
import { type PeerbitLike, usePeer, useProgram } from "@peerbit/react";
import {
    createContext,
    type ReactNode,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { matchPath, useLocation } from "react-router";
import { STREAM } from "./streamRoutes";
import {
    selectStreamProgramTarget,
    type StreamProgramOwnership,
    type StreamRoute,
} from "./streamProgramOwnership";

const routeFromPathname = (pathname: string): StreamRoute => {
    if (pathname === "/") {
        return { kind: "create" };
    }

    const match = matchPath(
        { path: `/${STREAM}`, end: true, caseSensitive: false },
        pathname
    );
    const address = match?.params.address;
    return address ? { kind: "stream", address } : { kind: "outside" };
};

const addressOf = (program: MediaStreamDB): string | undefined => {
    try {
        return program.address.toString();
    } catch {
        return undefined;
    }
};

const StreamProgramContext = createContext<MediaStreamDB | undefined>(
    undefined
);
const createdProgramRequestIds = new WeakMap<MediaStreamDB, string>();
let createdProgramRequestSequence = 0;

const getCreatedProgramRequestId = (program: MediaStreamDB) => {
    let requestId = createdProgramRequestIds.get(program);
    if (!requestId) {
        requestId = `created-${++createdProgramRequestSequence}`;
        createdProgramRequestIds.set(program, requestId);
    }
    return requestId;
};

const StreamProgramRequest = ({
    children,
    createdRequestId,
    openingCreatedProgram,
    peer,
    target,
}: {
    children: ReactNode;
    createdRequestId?: string;
    openingCreatedProgram: boolean;
    peer: PeerbitLike;
    target: MediaStreamDB | string;
}) => {
    const opened = useProgram<MediaStreamDB>(peer, target, {
        existing: "reuse",
        id: createdRequestId,
        args: openingCreatedProgram ? { replicate: "all" } : undefined,
    });
    const requestedAddress =
        typeof target === "string" ? target : addressOf(target);
    const openedAddress = opened.program && addressOf(opened.program);
    const program =
        opened.program &&
        (opened.program === target ||
            (requestedAddress !== undefined &&
                openedAddress === requestedAddress))
            ? opened.program
            : undefined;

    return (
        <StreamProgramContext.Provider value={program}>
            {children}
        </StreamProgramContext.Provider>
    );
};

const sameOwnership = (
    left: StreamProgramOwnership<MediaStreamDB>,
    right: StreamProgramOwnership<MediaStreamDB>
) =>
    left.created === right.created &&
    left.peerId === right.peerId &&
    left.wasCreateRoute === right.wasCreateRoute;

export const StreamProgramOwner = ({ children }: { children: ReactNode }) => {
    const { peer } = usePeer();
    const location = useLocation();
    const [ownership, setOwnership] = useState<
        StreamProgramOwnership<MediaStreamDB>
    >({
        created: undefined,
        peerId: undefined,
        wasCreateRoute: false,
    });
    const peerId = peer?.identity.publicKey.hashcode();
    const route = useMemo(
        () => routeFromPathname(location.pathname),
        [location.pathname]
    );
    const selection = useMemo(
        () =>
            selectStreamProgramTarget(
                ownership,
                route,
                peerId,
                () => new MediaStreamDB(peer!.identity.publicKey),
                (program) => addressOf(program) ?? ""
            ),
        [ownership, peer, peerId, route]
    );

    useEffect(() => {
        setOwnership((current) =>
            sameOwnership(current, selection.ownership)
                ? current
                : selection.ownership
        );
    }, [selection.ownership]);

    const target = selection.target;
    if (!peer || target == null) {
        return (
            <StreamProgramContext.Provider value={undefined}>
                {children}
            </StreamProgramContext.Provider>
        );
    }

    const openingCreatedProgram =
        typeof target !== "string" && target === selection.ownership.created;
    const createdRequestId = openingCreatedProgram
        ? getCreatedProgramRequestId(target as MediaStreamDB)
        : undefined;
    const requestKey = `${peerId}:${
        typeof target === "string" ? `address:${target}` : createdRequestId
    }`;
    return (
        <StreamProgramRequest
            key={requestKey}
            peer={peer}
            target={target}
            createdRequestId={createdRequestId}
            openingCreatedProgram={openingCreatedProgram}
        >
            {children}
        </StreamProgramRequest>
    );
};

export const useOwnedStreamProgram = () => useContext(StreamProgramContext);
