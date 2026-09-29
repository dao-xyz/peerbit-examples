module github.com/dao-xyz/peerbit-examples/packages/shared-fs/native

go 1.22

require github.com/winfsp/cgofuse v1.6.0

// Fork: v1.6.0 without the FUSE 3 init memset that wipes libfuse's -o timeouts; drop once https://github.com/winfsp/cgofuse/pull/110 is released.
replace github.com/winfsp/cgofuse => github.com/dao-xyz/cgofuse v1.6.0-peerbit.1
