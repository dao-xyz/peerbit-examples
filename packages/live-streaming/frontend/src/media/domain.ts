import { Entry, ShallowEntry } from "@peerbit/log";
import { type ReplicationDomain } from "@peerbit/shared-log";
import { Documents, type Operation, isPutOperation } from "@peerbit/document";

type RangeArgs = { from: number; to: number };
export type CustomDomain = ReplicationDomain<RangeArgs, Operation>;

export const createDocumentDomain = <T extends object>(
    db: Documents<T, any, CustomDomain>,
    options: {
        fromValue: (value: T) => number;
        fromMissing?: (entry: ShallowEntry | Entry<Operation>) => number;
    }
): CustomDomain => {
    const fromValue = options.fromValue;
    const fromMissing = options.fromMissing || (() => 0xffffffff);
    return {
        type: "custom",
        fromArgs(args, log) {
            if (!args) {
                return { offset: log.node.identity.publicKey };
            }
            return {
                offset: args.from,
                length: args.to - args.from,
            };
        },
        fromEntry: async (entry) => {
            const item = await (entry instanceof ShallowEntry
                ? await db.log.log.get(entry.hash)
                : entry
            )?.getPayloadValue();
            if (!item) {
                // @eslint-ignore no-console
                console.error("Item not found");
                return fromMissing(entry);
            }

            if (isPutOperation(item)) {
                const document = db.index.valueEncoding.decoder(item.data);
                return fromValue(document);
            }

            return fromMissing(entry);
        },
    };
};
