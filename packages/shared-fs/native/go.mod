module github.com/dao-xyz/peerbit-examples/packages/shared-fs/native

go 1.22

require github.com/winfsp/cgofuse v1.6.0

// Fork: v1.6.0 plus two FUSE 3 fixes; drop it once upstream releases both:
//   - no init memset that wipes libfuse's -o timeouts (https://github.com/winfsp/cgofuse/pull/110)
//   - also load libfuse3.so.4, the soname of libfuse >= 3.17 (https://github.com/winfsp/cgofuse/pull/112)
replace github.com/winfsp/cgofuse => github.com/dao-xyz/cgofuse v1.6.0-peerbit.2
