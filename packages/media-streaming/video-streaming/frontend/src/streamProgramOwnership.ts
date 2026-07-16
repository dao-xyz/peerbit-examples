export type StreamRoute =
    | { kind: "create" }
    | { kind: "stream"; address: string }
    | { kind: "outside" };

export type StreamProgramOwnership<T> = {
    created: T | undefined;
    peerId: string | undefined;
    wasCreateRoute: boolean;
};

type StreamProgramSelection<T> = {
    ownership: StreamProgramOwnership<T>;
    target: T | string | undefined;
};

export const selectStreamProgramTarget = <T>(
    ownership: StreamProgramOwnership<T>,
    route: StreamRoute,
    peerId: string | undefined,
    create: () => T,
    getAddress: (program: T) => string
): StreamProgramSelection<T> => {
    let created =
        peerId !== undefined && ownership.peerId === peerId
            ? ownership.created
            : undefined;

    if (!peerId) {
        return {
            ownership: {
                created: undefined,
                peerId: undefined,
                wasCreateRoute: route.kind === "create",
            },
            target: undefined,
        };
    }

    if (route.kind === "create") {
        if (!ownership.wasCreateRoute || !created) {
            created = create();
        }

        return {
            ownership: {
                created,
                peerId,
                wasCreateRoute: true,
            },
            target: created,
        };
    }

    if (
        route.kind === "stream" &&
        created &&
        getAddress(created) === route.address
    ) {
        return {
            ownership: {
                created,
                peerId,
                wasCreateRoute: false,
            },
            target: created,
        };
    }

    return {
        ownership: {
            created: undefined,
            peerId,
            wasCreateRoute: false,
        },
        target: route.kind === "stream" ? route.address : undefined,
    };
};
