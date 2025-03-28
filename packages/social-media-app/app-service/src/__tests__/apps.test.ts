import { CuratedWebApp, getApps } from "../apps";
import { expect } from "chai";

describe("index", () => {
    it("empty search yields all", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("");
        expect(response.length).to.be.greaterThan(3);
    });

    it("one letter yields not reasults", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("h");
        expect(response.length).to.be.equal(0);
    });

    it("resolve 'imag' partial", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("img");
        expect(response).to.have.length(1);
        // Native apps may have a flag or property; here we simply check for the expected URL.
        expect(response[0].url).to.eq("native:image");
    });

    it("resolve 'twi' partial", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("TwIt");
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq("https://twitch.tv");
    });

    it("resolve twitch xqc", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("TwiTch xqc");
        expect(response).to.have.length(1);
        expect(response[0].title).to.eq("Twitch Channel xqc");
        expect(response[0].url).to.eq(
            "https://player.twitch.tv/?channel=xqc&parent=www.host.com"
        );
    });

    it("resolve 'https://www.twitch.tv/xqc'", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("https://www.twitch.tv/xqc");
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq(
            "https://player.twitch.tv/?channel=xqc&parent=www.host.com"
        );
    });

    it("resolve kick maki95", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("kick maki95");
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq(
            "https://player.kick.com/maki95?autoplay=true"
        );
    });

    it("figjam", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search(
            "https://www.figma.com/board/xyz123/jamjam?node-id=0-1&p=f&t=extravariable-0"
        );
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq(
            "https://embed.figma.com/board/xyz123/jamjam?node-id=0-1&embed-host=share"
        );
    });

    it("chess prod", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "production",
        });
        const response = await search("che");
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq("https://chess.dao.xyz");
    });

    describe("getStatus implementations", () => {
        const host = "www.host.com";
        // Use development mode for testing web apps getStatus (except the chess prod test above)
        const { curated } = getApps({ host, mode: "development" });

        // Helper to get a web app by a substring in its match array.
        const getWebApp = (matchSubstr: string): CuratedWebApp =>
            curated.find(
                (app) =>
                    app.type === "web" &&
                    (Array.isArray(app.match)
                        ? app.match.some((m) =>
                              m
                                  .toLowerCase()
                                  .includes(matchSubstr.toLowerCase())
                          )
                        : app.match
                              .toLowerCase()
                              .includes(matchSubstr.toLowerCase()))
            ) as CuratedWebApp;

        // --- Twitch ---
        const twitchApp = getWebApp("twitch");
        it("Twitch: valid getStatus", () => {
            if (!twitchApp) throw new Error("Twitch app not found");
            const status = twitchApp.getStatus(
                "https://player.twitch.tv/?channel=xqc&parent=www.host.com",
                host
            );
            expect(status.isReady).to.be.true;
        });
        it("Twitch: invalid getStatus (missing parent)", () => {
            if (!twitchApp) throw new Error("Twitch app not found");
            const status = twitchApp.getStatus(
                "https://player.twitch.tv/?channel=xqc",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain("Invalid URL");
        });

        // --- Kick ---
        const kickApp = getWebApp("kick");
        it("Kick: valid getStatus", () => {
            if (!kickApp) throw new Error("Kick app not found");
            const status = kickApp.getStatus(
                "https://player.kick.com/maki95?autoplay=true",
                host
            );
            expect(status.isReady).to.be.true;
        });
        it("Kick: invalid getStatus (no username provided)", () => {
            if (!kickApp) throw new Error("Kick app not found");
            const status = kickApp.getStatus(
                "https://player.kick.com/?autoplay=true",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "No username provided"
            );
        });

        // --- FigJam ---
        const figjamApp = getWebApp("figma.com/board");
        it("FigJam: valid getStatus", () => {
            if (!figjamApp) throw new Error("FigJam app not found");
            const status = figjamApp.getStatus(
                "https://embed.figma.com/board/xyz123/jamjam?node-id=0-1&embed-host=share",
                host
            );
            expect(status.isReady).to.be.true;
        });
        it("FigJam: invalid getStatus", () => {
            if (!figjamApp) throw new Error("FigJam app not found");
            const status = figjamApp.getStatus(
                "https://www.figma.com/board/xyz123/jamjam",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid FigJam board URL"
            );
        });
        it("FigJam: invalid getStatus - 2", () => {
            if (!figjamApp) throw new Error("FigJam app not found");
            const status = figjamApp.getStatus(
                "https://embed.figma.com/board/",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid FigJam board URL"
            );
        });

        // --- YouTube ---
        const youtubeApp = getWebApp("youtube.com/watch?v=");
        it("YouTube: valid getStatus for embed URL", () => {
            if (!youtubeApp) throw new Error("YouTube app not found");
            const status = youtubeApp.getStatus(
                "https://www.youtube.com/embed/abc123",
                host
            );
            expect(status.isReady).to.be.true;
        });
        it("YouTube: valid getStatus for watch URL", () => {
            if (!youtubeApp) throw new Error("YouTube app not found");
            const status = youtubeApp.getStatus(
                "https://www.youtube.com/watch?v=eBDRsSgeloE",
                host
            );
            expect(status.isReady).to.be.true;
        });
        it("YouTube: invalid getStatus with missing id", () => {
            if (!youtubeApp) throw new Error("YouTube app not found");
            const status = youtubeApp.getStatus(
                "https://www.youtube.com/watch?v=",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Missing video id"
            );
        });

        // --- Generic Video Stream ---
        const videoApp = getWebApp("video");
        it("Generic Video: valid getStatus", () => {
            if (!videoApp) throw new Error("Video app not found");
            // For development mode the expected URL is from STREAMING_APP(mode)
            const validUrl = "https://stream.test.xyz:5801";
            const status = videoApp.getStatus(validUrl, host);
            expect(status.isReady).to.be.true;
        });
        it("Generic Video: invalid getStatus", () => {
            if (!videoApp) throw new Error("Video app not found");
            const status = videoApp.getStatus(
                "https://invalid-stream.com",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid video stream URL"
            );
        });

        // --- Chess ---
        const chessApp = getWebApp("chess");
        it("Chess: valid getStatus", () => {
            if (!chessApp) throw new Error("Chess app not found");
            // For development mode the expected URL is from CHESS_APP(mode)
            const validUrl = "https://chess.test.xyz:5806";
            const status = chessApp.getStatus(validUrl, host);
            expect(status.isReady).to.be.true;
        });
        it("Chess: invalid getStatus", () => {
            if (!chessApp) throw new Error("Chess app not found");
            const status = chessApp.getStatus(
                "https://invalid-chess.com",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid chess app URL"
            );
        });
    });
});
