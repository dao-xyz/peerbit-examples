export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const rangeMediaPaths = new Set(JSON.parse(env.RANGE_MEDIA_PATHS));
        if (!rangeMediaPaths.has(url.pathname)) {
            return env.ASSETS.fetch(request);
        }

        // Workers Cache handles the client Range header outside this Worker:
        // it stores this full 200 response and synthesizes byte-exact 206/416
        // responses. Always fetch the canonical representation from Assets.
        const headers = new Headers(request.headers);
        headers.delete("range");
        headers.delete("if-range");
        headers.set("accept-encoding", "identity");
        const assetRequest = new Request(request, { headers });
        const assetResponse = await env.ASSETS.fetch(assetRequest);

        if (assetResponse.status !== 200) {
            return assetResponse;
        }

        const responseHeaders = new Headers(assetResponse.headers);
        responseHeaders.set("Accept-Ranges", "bytes");
        responseHeaders.set(
            "Cache-Control",
            "public, max-age=0, s-maxage=86400, must-revalidate"
        );
        return new Response(assetResponse.body, {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers: responseHeaders,
        });
    },
};
