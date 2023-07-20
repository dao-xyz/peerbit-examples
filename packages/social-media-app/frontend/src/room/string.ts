import { field, variant, fixedArray, vec } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    Documents,
    Operation,
    PutOperation,
    Role,
    SearchRequest,
    Sort,
    SortDirection,
} from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Ed25519Keypair } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { SyncFilter } from "@peerbit/shared-log";
import { CanAppend, Change, Entry, TrimOptions } from "@peerbit/log";

@variant(0)
class StringElement {
    @field({ type: Uint8Array })
    id: Uint8Array;
    @field({ type: "string" })
    string: string;

    constructor(string: string, id: Uint8Array = randomBytes(32)) {
        this.id = id;
        this.string = string;
    }
}

type Args = { canAppend: CanAppend<Operation<StringElement>> };

/**
 * A simple, last write wins string
 */
@variant("editable_string")
export class EditableString extends Program<Args> {
    @field({ type: Documents<Element> })
    versions: Documents<StringElement>;

    constructor() {
        super();
    }

    open(args?: Args): Promise<void> {
        return this.versions.open({
            type: StringElement,
            canAppend: args.canAppend,
            index: {
                fields: (obj, context) => {
                    return {
                        id: obj.id,
                        timestamp: context.modified,
                        string: obj.string,
                    };
                },
            },
        });
    }

    async setValue(string: string): Promise<void> {
        await this.versions.put(
            new StringElement(
                string,
                (
                    await this.getLatest({ local: true, remote: false })
                ).id
            )
        );
    }

    private async getLatest(
        properties: { local: boolean; remote: boolean } = {
            local: true,
            remote: true,
        }
    ): Promise<StringElement> {
        return (await this.versions.index.search(
            new SearchRequest({
                sort: new Sort({
                    key: "timestamp",
                    direction: SortDirection.DESC,
                }),
            })
        ),
        properties)[0];
    }
    async getValue(
        properties: { local: boolean; remote: boolean } = {
            local: true,
            remote: true,
        }
    ): Promise<string> {
        return (await this.getLatest(properties))[0].string || "";
    }
}
