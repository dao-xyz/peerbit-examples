import { describe, it } from "vitest";
import { expect } from "chai";
import { extractOpenGraphImageUrl, inferImageDimensions } from "../images.js";

describe("images utils", () => {
    it("extracts og:image and resolves relative URLs", () => {
        const html = `
            <html>
              <head>
                <meta property="og:image" content="/img/hero.jpg" />
              </head>
            </html>
        `;

        const url = extractOpenGraphImageUrl(html, "https://example.com/a/b");
        expect(url).to.equal("https://example.com/img/hero.jpg");
    });

    it("infers PNG dimensions from header", () => {
        const bytes = new Uint8Array(24);
        // PNG signature
        bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        // width=640, height=480 at offsets 16 and 20 (big-endian)
        bytes.set([0x00, 0x00, 0x02, 0x80], 16);
        bytes.set([0x00, 0x00, 0x01, 0xe0], 20);

        const dims = inferImageDimensions(bytes, "image/png");
        expect(dims).to.deep.equal({ width: 640, height: 480 });
    });

    it("infers JPEG dimensions from SOF marker", () => {
        const bytes = new Uint8Array([
            0xff,
            0xd8, // SOI
            0xff,
            0xc0, // SOF0
            0x00,
            0x11, // segment length 17
            0x08, // precision
            0x00,
            0x10, // height 16
            0x00,
            0x20, // width 32
            0x03, // components
            0x01,
            0x11,
            0x00,
            0x02,
            0x11,
            0x00,
            0x03,
            0x11,
            0x00,
            0xff,
            0xd9, // EOI
        ]);

        const dims = inferImageDimensions(bytes);
        expect(dims).to.deep.equal({ width: 32, height: 16 });
    });
});
