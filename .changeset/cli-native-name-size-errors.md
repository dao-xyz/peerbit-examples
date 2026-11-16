---
"@peerbit/shared-fs-cli": patch
---

The native adapter passes the library's new `ENAMETOOLONG` and `EFBIG` errors
to the kernel as themselves instead of `EIO`: creating or renaming to a name
of more than 255 bytes of UTF-8 fails with `ENAMETOOLONG`, and growing a
mounted file past 32 GiB fails with `EFBIG`. The change reaches users through
this CLI version's adapter release (`shared-fs-native-v<version>`).
