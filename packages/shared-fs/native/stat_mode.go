package main

import "runtime"

const (
	statModeTypeMask  = 0o170000
	statModeDirectory = 0o040000
	statModeRegular   = 0o100000
)

func nativeStatMode(mode uint32) uint32 {
	return platformStatMode(mode, runtime.GOOS)
}

func platformStatMode(mode uint32, goos string) uint32 {
	if goos != "windows" {
		return mode
	}
	switch mode & statModeTypeMask {
	case statModeDirectory:
		return (mode & statModeTypeMask) | 0o777
	case statModeRegular:
		return (mode & statModeTypeMask) | 0o666
	default:
		return mode
	}
}
