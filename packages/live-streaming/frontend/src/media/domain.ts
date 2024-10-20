import { Entry, ShallowEntry } from "@peerbit/log";
import { EntryReplicated, type ReplicationDomain } from "@peerbit/shared-log";
import { Documents, type Operation, isPutOperation } from "@peerbit/document";

type RangeArgs = { from: number; to: number };
export type CustomDomain = ReplicationDomain<RangeArgs, Operation>;
type FromEntry = {
    fromEntry?: (
        entry: ShallowEntry | Entry<Operation> | EntryReplicated
    ) => number;
};
type FromValue<T> = {
    fromValue?: (
        value: T | undefined,
        entry: ShallowEntry | Entry<Operation>
    ) => number;
};

export const createDocumentDomain = <T extends object>(
    db: Documents<T, any, CustomDomain>,
    options: FromEntry | FromValue<T>
): CustomDomain => {
    let fromEntry = (options as FromEntry).fromEntry
        ? (options as FromEntry).fromEntry!
        : async (entry) => {
              const item = await (entry instanceof ShallowEntry
                  ? await db.log.log.get(entry.hash)
                  : entry
              )?.getPayloadValue();

              let document: T | undefined = undefined;
              if (!item) {
                  // @eslint-ignore no-console
                  console.error("Item not found");
              } else if (isPutOperation(item)) {
                  document = db.index.valueEncoding.decoder(item.data);
              }
              return (options as FromValue<T>).fromValue!(document, entry);
          };
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
        fromEntry,
    };
};
