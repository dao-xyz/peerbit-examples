# File-share utils

An example how one can use a Document store to store files.


## CLI

There is a CLI application inside [./cli](./cli), that allows you to do the basic functionality.


To run it locally:

First go to the root folder of the exampels repo and build it

```
yarn build
```

Then go back to the [./cli](./cli) folder and now you can do: 

Put (to provide a file)
```sh
node  ./cli/lib/esm/bin.js put PATH
```

Get (to get a file)
```sh
node ./cli/lib/esm/bin.js get ID [PATH (optional)]
```

The cli is not yet published, hence why you have to write `node  ./cli/lib/esm/bin.js` before the command. But `@peerbit/please` (might be) the name for CLI app in the future.