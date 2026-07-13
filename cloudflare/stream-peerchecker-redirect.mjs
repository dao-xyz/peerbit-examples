export default {
    fetch(_request, env) {
        // The retired app used an incompatible hash route format, so do not
        // preserve its fragment. Always land on the current application root.
        return Response.redirect(
            env.CANONICAL_STREAM_URL,
            Number(env.REDIRECT_STATUS)
        );
    },
};
