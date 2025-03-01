import { field, variant } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    Sort,
    CanPerform,
    SortDirection,
} from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Program } from "@peerbit/program";

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

class StringElementIndexable {
    @field({ type: Uint8Array })
    id: Uint8Array;
    @field({ type: "string" })
    string: string;
    @field({ type: "u64" })
    timestamp: bigint;

    constructor(element: StringElement, timestamp: bigint) {
        this.id = element.id;
        this.string = element.string;
        this.timestamp = timestamp;
    }
}

type Args = { canPerform: CanPerform<StringElement> };

/**
 * A simple, last write wins string
 */
@variant("editable_string")
export class EditableString extends Program<Args> {
    @field({ type: Documents<Element> })
    versions: Documents<StringElement, StringElementIndexable>;

    constructor() {
        super();
    }

    open(args?: Args): Promise<void> {
        return this.versions.open({
            type: StringElement,
            canPerform: args.canPerform,
            index: {
                type: StringElementIndexable,
                transform: (obj, context) => {
                    return new StringElementIndexable(obj, context.modified);
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
