/* const {
    override,
    addBabelPlugins,
    addExternalBabelPlugins,
    addWebpackPlugin,
} = require('customize-cra');
const { DefinePlugin } = require('webpack');
 */
const { addBabelPlugins, disableEsLint, override } = require("customize-cra");
const TerserPlugin = require("terser-webpack-plugin");

/* const webpack = require('webpack');
 */

module.exports = (config) => {
    let loaders = config.resolve;
    loaders.fallback = {
        /*     
            
             "path": require.resolve("path-browserify"),
             "buffer": require.resolve("buffer"),
             
             */
        child_process: false,
        fs: false,
        assert: false,
        os: false,
        http: false,
        util: false,
        yargs: false,
        net: false,
        "aws-sdk": false,
        url: false,
        path: require.resolve("path-browserify"),
        crypto: require.resolve("crypto-browserify"),
        stream: require.resolve("stream-browserify"),
        timers: require.resolve("timers-browserify"),
        buffer: require.resolve("buffer"),
    };
    disableEsLint();
    /*  config.module.rules = [
         ...config.module.rules,
         {
             test: /\.m?js/,
             resolve: {
                 fullySpecified: false,
             },
         },
     ]; */
    config.experiments = {
        topLevelAwait: true,
    };

    return config;
};
