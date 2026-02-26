import crypto from "crypto";
import { Peerbit } from "peerbit";
import { Files } from "../index.js";
import { equals } from "uint8arrays";
import { waitForResolved } from "@peerbit/time";
import { expect, describe, it } from "vitest";

describe("file-share late join", () => {
	it(
		"can fetch a large file when the reader joins after upload",
		async () => {
			const writer = await Peerbit.create();
			const reader = await Peerbit.create();
			try {
				const files = await writer.open(new Files());
				const fileName = "late-join-large-file";
				const bytes = crypto.randomBytes(12 * 1e6) as Uint8Array; // > 5 MB so chunking path is used

				await files.add(fileName, bytes);

				await writer.dial(reader);

				const readerFiles = await reader.open<Files>(files.address, {
					args: { replicate: false },
				});
				await readerFiles.files.log.waitForReplicator(
					writer.identity.publicKey,
				);

				await waitForResolved(
					async () => {
						const listed = await readerFiles.list();
						expect(listed.some((x) => x.name === fileName)).to.be.true;
					},
					{ timeout: 120_000, delayInterval: 1_000 },
				);

				const fetched = await readerFiles.getByName(fileName);
				expect(fetched).to.not.be.undefined;
				expect(equals(fetched!.bytes, bytes)).to.be.true;
			} finally {
				await Promise.allSettled([writer.stop(), reader.stop()]);
			}
		},
		180_000,
	);
});

