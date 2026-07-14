import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { Peerbit } from "peerbit";
import { ImageItems, NamedItems, StoraOfLibraries } from "../index.js";

describe("music library indexes", () => {
    let peer: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("opens every indexed program and persists its local records", async () => {
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
    });
});
