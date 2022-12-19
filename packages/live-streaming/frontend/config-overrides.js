const { disableEsLint } = require("customize-cra");
module.exports = (config) => {
    let loaders = config.resolve;
    loaders.fallback = {
        path: require.resolve("path-browserify"),
    };
    disableEsLint();
    config.experiments = {
        topLevelAwait: true,
    };

    return config;
};
