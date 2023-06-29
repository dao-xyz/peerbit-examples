# File-share utils

An example how one can use a Document store to store files.


## CLI

There is a CLI application inside [./file-share](./file-share), that allows you to do basic functionality


First go to the root folder of the exampels repo and build it

```
yarn build
```


Then go back to this folder and run

Put (to provide a file)
```sh
./cli/lib/esm/bin.js put PATH
```

Get (to get a file)
```sh
./cli/lib/esm/bin.js get ID [PATH (optional)]
```

The cli is not yet published, but `plopp` (might be) the name for CLI app in the future.