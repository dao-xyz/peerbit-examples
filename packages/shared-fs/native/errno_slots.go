package main

// EDQUOT has no cgofuse constant, and Linux and macOS number it differently.
// Windows has none: the adapter reports a quota as ENOSPC there.
const (
	linuxEDQUOT  = 122
	darwinEDQUOT = 69
)

// edquotErrno is EDQUOT's errno on goos, or 0 where there is none.
func edquotErrno(goos string) int {
	switch goos {
	case "linux":
		return linuxEDQUOT
	case "darwin":
		return darwinEDQUOT
	}
	return 0
}
