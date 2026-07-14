import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IFrameResizer from "../IFrameResizer";

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe("iframe-resizer close protocol", () => {
    it("never lets child close messages remove React-owned frames", async () => {
        const iframeRef = React.createRef<HTMLIFrameElement>();
        render(
            React.createElement(
                IFrameResizer,
                {
                    license: "GPLv3",
                    iframeRef,
                    onResize: vi.fn(),
                },
                React.createElement("iframe", {
                    ref: iframeRef,
                    src: `${window.location.origin}/app`,
                    srcDoc: "<!doctype html><title>owned app</title>",
                    title: "resized-app",
                })
            )
        );

        const iframe = iframeRef.current;
        const embeddedWindow = iframe?.contentWindow;
        if (!iframe || !embeddedWindow) {
            throw new Error("Test iframe has no contentWindow");
        }
        // Happy DOM models srcdoc as an opaque origin. Avoid its asynchronous
        // target-origin error; the parent protocol listener below is real.
        vi.spyOn(embeddedWindow, "postMessage").mockImplementation(() => {});

        await waitFor(() => {
            expect(
                (
                    iframeRef.current as
                        | (HTMLIFrameElement & { iframeResizer?: unknown })
                        | null
                )?.iframeResizer
            ).toBeDefined();
        });

        const sameOriginWindow = document.createElement("iframe");
        sameOriginWindow.src = `${window.location.origin}/other-app`;
        sameOriginWindow.srcdoc =
            "<!doctype html><title>other owned app</title>";
        document.body.appendChild(sameOriginWindow);
        const distinctWindow = sameOriginWindow.contentWindow;
        if (!distinctWindow) {
            throw new Error("Second test iframe has no contentWindow");
        }
        expect(Object.is(distinctWindow, embeddedWindow)).toBe(false);

        const requestClose = (source: Window) => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: `[iFrameSizer]${iframe.id}:0:0:close`,
                    origin: window.location.origin,
                    source,
                })
            );
            expect(document.body.contains(iframe)).toBe(true);
        };

        // Exercise the actual v5 wire protocol from both the embedded window
        // and a different window that shares its allowed origin.
        requestClose(embeddedWindow);
        requestClose(distinctWindow);
    });
});
