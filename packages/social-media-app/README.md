# 🚧 WIP 🚧

This app requires you to run all dependent apps (sub-apps) in the background. Todo so you also need to serve them using self signed certificates, that you create and put in `.cert`folders of each sub-application.

To generate certificates run 

```sh
openssl req -x509 -sha256 -new -nodes -days 3650 -key CA.key -out CA.pem
```

To add a domain name to your system you can modify you hosts file, e.g. add 

```sh
127.0.0.1 text.test.xyz
```

to support the use of `text.test.xyz` so you can interact with the app from the [text-document](./../text-document/) demo.

To see the domain names you need to support to run all apps, check corrsponding `vite.config.remote.ts` files.'


