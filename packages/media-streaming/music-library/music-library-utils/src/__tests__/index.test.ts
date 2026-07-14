import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { Peerbit } from "peerbit";
import { isPutOperation } from "@peerbit/document";
import { ImageItems, NamedItems, StoraOfLibraries } from "../index.js";

describe("music library indexes", () => {
    let peer: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("keeps stored encodings compatible and restores indexes after reopen", async () => {
        const libraries = await peer.open(new StoraOfLibraries(), {
            args: { replicate: false },
        });
        const names = await peer.open(new NamedItems(), {
            args: { replicate: false },
        });
        const images = await peer.open(new ImageItems(), {
            args: { replicate: false },
        });

        expect(await libraries.libraries.index.getSize()).to.equal(0);

        const itemId = new Uint8Array([1, 2, 3, 4]);
        await names.setName(itemId, "Test track");
        await images.setImage(itemId, new Uint8Array([5, 6, 7]), 1, 1);

        expect((await names.documents.index.get(itemId))?.name).to.equal(
            "Test track"
        );
        expect((await images.documents.index.get(itemId))?.id).to.deep.equal(
            itemId
        );

        const nameEntry = (await names.documents.log.log.toArray())[0];
        const nameOperation = await nameEntry.getPayloadValue();
        if (!isPutOperation(nameOperation)) {
            throw new Error("Expected the stored name to be a put operation");
        }
        expect(nameOperation.data).to.deep.equal(
            new Uint8Array([
                4, 0, 0, 0, 1, 2, 3, 4, 10, 0, 0, 0, 84, 101, 115, 116, 32, 116,
                114, 97, 99, 107,
            ])
        );

        const imageEntry = (await images.documents.log.log.toArray())[0];
        const imageOperation = await imageEntry.getPayloadValue();
        if (!isPutOperation(imageOperation)) {
            throw new Error("Expected the stored image to be a put operation");
        }
        expect(imageOperation.data).to.deep.equal(
            new Uint8Array([
                4, 0, 0, 0, 1, 2, 3, 4, 3, 0, 0, 0, 5, 6, 7, 1, 0, 0, 0, 1, 0,
                0, 0,
            ])
        );

        await libraries.close();
        await names.close();
        await images.close();

        const reopenedLibraries = await peer.open(new StoraOfLibraries(), {
            args: { replicate: false },
        });
        const reopenedNames = await peer.open(new NamedItems(), {
            args: { replicate: false },
        });
        const reopenedImages = await peer.open(new ImageItems(), {
            args: { replicate: false },
        });

        expect(await reopenedLibraries.libraries.index.getSize()).to.equal(0);
        expect(
            (await reopenedNames.documents.index.get(itemId))?.name
        ).to.equal("Test track");
        expect(
            (await reopenedImages.documents.index.get(itemId))?.id
        ).to.deep.equal(itemId);
    });
});
