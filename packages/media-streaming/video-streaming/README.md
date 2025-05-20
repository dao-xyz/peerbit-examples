# Livestreaming app

[<img src="./demo.gif" width="600" />](./packages/live-streaming/)


## [Application is live here](https://stream.dao.xyz)


Due to the use of WebCodecs API, this app does not yet work on Firefox ([soon?](https://groups.google.com/a/mozilla.org/g/dev-platform/c/3g0fnn6682A)), and some mobile phones.

Learn more here: https://caniuse.com/webcodecs

This app is running from Browser to Browser. A relay is hosted in a datacenter that allows peers to discover and communicate with each other.

## How it works
This app showcase what kind of TPS and data throughput you can get with a Document store. The streamer records their stream, and every 50ms create a video chunk, which is inserted into the document store. This chunk is then replicated on peers that also have opened the database. These peers are subcribing to change events on the document store. Each change event will contain one or more chunk which they can append to a video stream (which shows up on the screen)

See [database schema](./frontend/src/media/database.ts) to learn about how the database is setup.

## To run with remote relay
```sh
yarn start-remote
```

## To run locally 
```sh
yarn start
```
