const CANONICAL_STREAM_URL = "https://stream.dao.xyz/#/";

export default {
    fetch() {
        // The retired app used an incompatible hash route format, so do not
        // preserve its fragment. Always land on the current application root.
        return Response.redirect(CANONICAL_STREAM_URL, 307);
    },
};
