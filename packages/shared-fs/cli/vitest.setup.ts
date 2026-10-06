// The library's setup (which loads the root one) installs the K2 readiness
// shadow check: the CLI opens, closes and reopens filesystems in-process
// through the built library, which reads the same registry.
import "../library/vitest.setup.ts";
