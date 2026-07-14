import { CuratedWebApp, getApps } from "../apps.js";
import { expect } from "chai";
import { describe, it } from "vitest";

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

    it("normalizes a Kick channel URL without producing a double slash", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "development",
        });
        const response = await search("https://www.kick.com/maki95");
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
            "https://embed.figma.com/board/xyz123?node-id=0-1&embed-host=share"
        );
    });

    it("chess prod", async () => {
        const { search } = getApps({
            host: "www.host.com",
            mode: "production",
        });
        const response = await search("che");
        expect(response).to.have.length(1);
        expect(response[0].url).to.eq("https://chess.apps.peerbit.org");
    });

    it("uses configured app URLs consistently", async () => {
        const chess = "https://chess-preview.example.invalid";
        const { curated, search } = getApps({
            host: "www.host.com",
            mode: "production",
            appUrls: { chess },
        });
        const chessApp = curated.find(
            (app) => app.type === "web" && app.manifest?.title === "Chess"
        ) as CuratedWebApp;

        expect(chessApp.manifest?.url).to.eq(chess);
        expect(chessApp.getStatus(chess, "www.host.com")).to.deep.eq({
            isReady: true,
        });
        expect((await search("chess"))[0].url).to.eq(chess);
    });

    describe("strict curated iframe URL resolution", () => {
        const host = "www.host.com";
        const apps = getApps({ host, mode: "development" });

        const resolvesSearchResult = async (
            query: string,
            expectedUrl: string,
            expectedPermissions: readonly string[]
        ) => {
            const result = await apps.search(query);
            expect(result).to.have.length(1);
            expect(result[0].url).to.eq(expectedUrl);
            expect(
                apps.resolveCuratedWebApp(result[0].url)?.iframePermissions
            ).to.deep.eq(expectedPermissions);
        };

        it("resolves transformed Twitch embeds with only playback capabilities", async () => {
            await resolvesSearchResult(
                "https://www.twitch.tv/xqc",
                "https://player.twitch.tv/?channel=xqc&parent=www.host.com",
                ["autoplay", "fullscreen", "picture-in-picture"]
            );
        });

        it("resolves transformed Kick embeds with only playback capabilities", async () => {
            await resolvesSearchResult(
                "https://www.kick.com/maki95",
                "https://player.kick.com/maki95?autoplay=true",
                ["autoplay", "fullscreen", "picture-in-picture"]
            );
        });

        it("resolves transformed FigJam embeds with board capabilities", async () => {
            await resolvesSearchResult(
                "https://www.figma.com/board/xyz123/jamjam?node-id=0-1&p=f",
                "https://embed.figma.com/board/xyz123?node-id=0-1&embed-host=share",
                ["clipboard-write", "fullscreen"]
            );
        });

        it("resolves transformed YouTube embeds and drops unrelated watch parameters", async () => {
            await resolvesSearchResult(
                "https://www.youtube.com/watch?v=eBDRsSgeloE&list=attacker",
                "https://www.youtube.com/embed/eBDRsSgeloE",
                [
                    "autoplay",
                    "encrypted-media",
                    "fullscreen",
                    "picture-in-picture",
                ]
            );
        });

        it("preserves the existing exact Stream and Chess policies", () => {
            expect(
                apps.resolveCuratedWebApp("https://stream.test:5801")
                    ?.iframePermissions
            ).to.deep.eq([
                "autoplay",
                "camera",
                "clipboard-write",
                "display-capture",
                "fullscreen",
                "microphone",
            ]);
            expect(
                apps.resolveCuratedWebApp("https://chess.test:5806")
                    ?.iframePermissions
            ).to.deep.eq([]);
            expect(
                apps.resolveCuratedWebApp("https://stream.test:5801")
                    ?.iframeResizer
            ).to.eq(true);
            expect(
                apps.resolveCuratedWebApp("https://chess.test:5806")
                    ?.iframeResizer
            ).to.eq(true);
            expect(apps.resolveCuratedWebApp("https://stream.test:5802")).to.eq(
                undefined
            );
            expect(
                apps.resolveCuratedWebApp("https://stream.test:5801/watch")
            ).to.eq(undefined);
        });

        it("rejects attacker origins, credentials, non-HTTPS URLs, and unexpected ports", () => {
            for (const url of [
                "https://player.kick.com.attacker.example/maki95?autoplay=true",
                "https://player.kick.com@attacker.example/maki95?autoplay=true",
                "https://user:pass@player.kick.com/maki95?autoplay=true",
                "http://player.kick.com/maki95?autoplay=true",
                "https://player.kick.com:444/maki95?autoplay=true",
                "https://www.youtube.com.attacker.example/embed/eBDRsSgeloE",
                "https://embed.figma.com.attacker.example/board/xyz123/jamjam?embed-host=share",
                "https://player.twitch.tv.attacker.example/?channel=xqc&parent=www.host.com",
            ]) {
                expect(apps.resolveCuratedWebApp(url), url).to.eq(undefined);
            }
        });

        it("rejects Kick host, path, query, and fragment abuse", () => {
            for (const url of [
                "https://kick.com/maki95?autoplay=true",
                "https://player.kick.com/?autoplay=true",
                "https://player.kick.com/maki95/second?autoplay=true",
                "https://player.kick.com/maki95%2Fsecond?autoplay=true",
                "https://player.kick.com/maki95?autoplay=false",
                "https://player.kick.com/maki95?autoplay=true&extra=1",
                "https://player.kick.com/maki95?autoplay=true#other",
            ]) {
                expect(apps.resolveCuratedWebApp(url), url).to.eq(undefined);
            }
        });

        it("rejects malformed Twitch, YouTube, and FigJam embed shapes", () => {
            for (const url of [
                "https://player.twitch.tv/watch?channel=xqc&parent=www.host.com",
                "https://player.twitch.tv/?channel=xqc&parent=wrong.host.com",
                "https://player.twitch.tv/?channel=xqc&parent=www.host.com&extra=1",
                "https://www.youtube.com/watch?v=eBDRsSgeloE",
                "https://www.youtube.com/embed/eBDRsSgeloE/second",
                "https://www.youtube.com/embed/eBDRsSgeloE?autoplay=1",
                "https://embed.figma.com/file/xyz123/jamjam?embed-host=share",
                "https://embed.figma.com/board/xyz123/jamjam?embed-host=share",
                "https://embed.figma.com/board/xyz123/slug%252F..%252Fsecret?embed-host=share",
                "https://embed.figma.com/board/xyz123/slug%25252F..%25252Fsecret?embed-host=share",
                "https://embed.figma.com/board/xyz123?embed-host=share&extra=1",
                "https://embed.figma.com/board/xyz123%2Fsecond?embed-host=share",
            ]) {
                expect(apps.resolveCuratedWebApp(url), url).to.eq(undefined);
            }
        });
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
            expect(twitchApp.iframePermissions).to.deep.eq([
                "autoplay",
                "fullscreen",
                "picture-in-picture",
            ]);
            expect(twitchApp.iframeResizer).not.to.eq(true);
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
            expect(kickApp.iframeResizer).not.to.eq(true);
        });
        it("Kick: invalid getStatus (no username provided)", () => {
            if (!kickApp) throw new Error("Kick app not found");
            const status = kickApp.getStatus(
                "https://player.kick.com/?autoplay=true",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid Kick embed URL"
            );
        });

        // --- FigJam ---
        const figjamApp = getWebApp("figma.com/board");
        it("FigJam: valid getStatus", () => {
            if (!figjamApp) throw new Error("FigJam app not found");
            const status = figjamApp.getStatus(
                "https://embed.figma.com/board/xyz123?node-id=0-1&embed-host=share",
                host
            );
            expect(status.isReady).to.be.true;
            expect(figjamApp.iframePermissions).to.deep.eq([
                "clipboard-write",
                "fullscreen",
            ]);
            expect(figjamApp.iframeResizer).not.to.eq(true);
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
        it("YouTube: rejects an untransformed watch URL", () => {
            if (!youtubeApp) throw new Error("YouTube app not found");
            const status = youtubeApp.getStatus(
                "https://www.youtube.com/watch?v=eBDRsSgeloE",
                host
            );
            expect(status.isReady).to.be.false;
        });
        it("YouTube: invalid getStatus with missing id", () => {
            if (!youtubeApp) throw new Error("YouTube app not found");
            const status = youtubeApp.getStatus(
                "https://www.youtube.com/watch?v=",
                host
            );
            expect(status.isReady).to.be.false;
            expect("info" in status && status.info).to.contain(
                "Invalid YouTube video URL"
            );
        });

        it("YouTube: grants only playback capabilities", () => {
            expect(youtubeApp.iframePermissions).to.deep.eq([
                "autoplay",
                "encrypted-media",
                "fullscreen",
                "picture-in-picture",
            ]);
            expect(youtubeApp.iframeResizer).not.to.eq(true);
        });

        // --- Generic Video Stream ---
        const videoApp = getWebApp("video");
        it("Generic Video: valid getStatus", () => {
            if (!videoApp) throw new Error("Video app not found");
            // For development mode the expected URL is from STREAMING_APP(mode)
            const validUrl = "https://stream.test:5801";
            const status = videoApp.getStatus(validUrl, host);
            expect(status.isReady).to.be.true;
            expect(videoApp.iframePermissions).to.deep.eq([
                "autoplay",
                "camera",
                "clipboard-write",
                "display-capture",
                "fullscreen",
                "microphone",
            ]);
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
            const validUrl = "https://chess.test:5806";
            const status = chessApp.getStatus(validUrl, host);
            expect(status.isReady).to.be.true;
            expect(chessApp.iframePermissions).to.deep.eq([]);
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
