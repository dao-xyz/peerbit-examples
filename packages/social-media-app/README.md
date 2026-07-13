# 🚧 WIP 🚧

This app can embed other examples from this repository. To use local versions,
run each required frontend with its `start-remote` script. The remote Vite
configurations use names under the RFC-reserved `.test` top-level domain, so
local development never depends on public DNS.

## Configure local names

Add this line to `/etc/hosts` on macOS or Linux, or to
`C:\Windows\System32\drivers\etc\hosts` on Windows:

```text
127.0.0.1 stream.test chess.test chat.test text.test filedrop.test social.test
```

## Create a trusted local certificate

Install [`mkcert`](https://github.com/FiloSottile/mkcert) with your operating
system's package manager. Then, from the repository root, create one certificate
covering every local name and copy it to the frontend directories that consume
`.cert/key.pem` and `.cert/cert.pem`:

```sh
mkcert -install

cert_dir="$(mktemp -d)"
mkcert \
  -cert-file "$cert_dir/cert.pem" \
  -key-file "$cert_dir/key.pem" \
  stream.test chess.test chat.test text.test filedrop.test social.test

for app_dir in \
  packages/media-streaming/video-streaming/frontend \
  packages/media-streaming/music-library/frontend \
  packages/chess/frontend \
  packages/one-chat-room/frontend \
  packages/text-document/frontend \
  packages/file-share/frontend \
  packages/social-media-app/frontend
do
  mkdir -p "$app_dir/.cert"
  cp "$cert_dir/key.pem" "$app_dir/.cert/key.pem"
  cp "$cert_dir/cert.pem" "$app_dir/.cert/cert.pem"
done

rm -rf "$cert_dir"
```

The `.cert` directories are ignored by Git. Never commit the generated private
key. Certificates issued for the previous public-DNS names do not match the new
names and must be replaced.

Run `pnpm start-remote` from each frontend directory you need. The music and
video frontends both use `stream.test:5801`, and the text and filedrop frontends
both bind port `5803` on the mapped loopback address. Run only one frontend from
each of those pairs at a time.
