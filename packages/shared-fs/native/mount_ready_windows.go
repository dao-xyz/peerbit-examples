//go:build native_mount && windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// mountWatcher waits for a drive mount's letter (see driveWatcher). WinFsp
// also sets a directory mountpoint only after init; the ready line does not
// wait for one.
type mountWatcher struct {
	drive *driveWatcher
}

// newMountWatcher must run before the mount, so that no arrival is missed.
func newMountWatcher(mountpoint string) (*mountWatcher, error) {
	drive, ok := mountDrive(mountpoint)
	if !ok {
		return nil, nil
	}
	watcher, err := newDriveWatcher(drive, windowsDrives{}, driveWaitLimit)
	if err != nil {
		return nil, err
	}
	return &mountWatcher{drive: watcher}, nil
}

func (w *mountWatcher) wait() error {
	if w == nil {
		return nil
	}
	return w.drive.wait()
}

// windowsDrives is the drive letter table this process sees: its logon
// session's letters and the global ones.
type windowsDrives struct{}

const (
	wmDestroy        = 0x0002
	wmClose          = 0x0010
	wmDeviceChange   = 0x0219
	dbtDeviceArrival = 0x8000

	errorClassAlreadyExists syscall.Errno = 1410
)

var (
	kernel32Procs        = syscall.NewLazyDLL("kernel32.dll")
	procGetModuleHandleW = kernel32Procs.NewProc("GetModuleHandleW")
	procQueryDosDeviceW  = kernel32Procs.NewProc("QueryDosDeviceW")
	user32Procs          = syscall.NewLazyDLL("user32.dll")
	procCreateWindowExW  = user32Procs.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32Procs.NewProc("DefWindowProcW")
	procDispatchMessageW = user32Procs.NewProc("DispatchMessageW")
	procGetMessageW      = user32Procs.NewProc("GetMessageW")
	procPostMessageW     = user32Procs.NewProc("PostMessageW")
	procPostQuitMessage  = user32Procs.NewProc("PostQuitMessage")
	procRegisterClassExW = user32Procs.NewProc("RegisterClassExW")
)

func (windowsDrives) defined(drive string) (bool, error) {
	name, err := syscall.UTF16PtrFromString(drive)
	if err != nil {
		return false, err
	}
	var target [syscall.MAX_PATH]uint16
	n, _, callErr := procQueryDosDeviceW.Call(
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(&target[0])),
		uintptr(len(target)),
	)
	switch {
	case uint32(n) != 0:
		return true, nil
	case errors.Is(callErr, syscall.ERROR_FILE_NOT_FOUND):
		return false, nil
	case errors.Is(callErr, syscall.ERROR_INSUFFICIENT_BUFFER):
		// Defined, with a longer target than the buffer holds.
		return true, nil
	}
	return false, fmt.Errorf("QueryDosDeviceW(%s): %w", drive, callErr)
}

// watch creates a hidden top-level window: DefineDosDevice broadcasts its
// WM_DEVICECHANGE to top-level windows, not to message-only ones. The window
// lives on a thread of its own, which runs its message loop until stop.
func (windowsDrives) watch(arrived func()) (func(), error) {
	created := make(chan error, 1)
	var window uintptr
	go func() {
		// The window belongs to this thread, which must pump its messages.
		// The thread ends with the goroutine (no UnlockOSThread).
		runtime.LockOSThread()
		var err error
		window, err = createArrivalWindow(arrived)
		created <- err
		if err == nil {
			pumpMessages()
		}
	}()
	if err := <-created; err != nil {
		return nil, err
	}
	var once sync.Once
	return func() {
		// DefWindowProc destroys the window, whose WM_DESTROY ends the loop.
		once.Do(func() { procPostMessageW.Call(window, wmClose, 0, 0) })
	}, nil
}

// wndClassEx is WNDCLASSEXW.
type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

// winMsg is MSG.
type winMsg struct {
	window  uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      [2]int32
	private uint32
}

var (
	arrivalClassOnce sync.Once
	arrivalClass     *uint16
	arrivalInstance  uintptr
	arrivalClassErr  error
	// arrivalWindows maps each window to its watcher's arrived.
	arrivalWindows sync.Map
)

// registerArrivalClass registers the window class once per process, with the
// one window procedure callback all watchers share.
func registerArrivalClass() error {
	arrivalClassOnce.Do(func() {
		for _, proc := range []*syscall.LazyProc{
			procCreateWindowExW, procDefWindowProcW, procDispatchMessageW,
			procGetMessageW, procPostMessageW, procPostQuitMessage,
			procRegisterClassExW, procGetModuleHandleW,
		} {
			if arrivalClassErr = proc.Find(); arrivalClassErr != nil {
				return
			}
		}
		instance, _, err := procGetModuleHandleW.Call(0)
		if instance == 0 {
			arrivalClassErr = fmt.Errorf("GetModuleHandleW: %w", err)
			return
		}
		name, err := syscall.UTF16PtrFromString("PeerbitSharedFsDriveArrival")
		if err != nil {
			arrivalClassErr = err
			return
		}
		class := wndClassEx{
			wndProc:   syscall.NewCallback(arrivalWindowProc),
			instance:  instance,
			className: name,
		}
		class.size = uint32(unsafe.Sizeof(class))
		atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
		if uint16(atom) == 0 && !errors.Is(err, errorClassAlreadyExists) {
			arrivalClassErr = fmt.Errorf("RegisterClassExW: %w", err)
			return
		}
		arrivalClass, arrivalInstance = name, instance
	})
	return arrivalClassErr
}

func createArrivalWindow(arrived func()) (uintptr, error) {
	if err := registerArrivalClass(); err != nil {
		return 0, err
	}
	window, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(arrivalClass)),
		0,
		0, // WS_OVERLAPPED without WS_VISIBLE: hidden
		0, 0, 0, 0,
		0, // no parent: a top-level window
		0,
		arrivalInstance,
		0,
	)
	if window == 0 {
		return 0, fmt.Errorf("CreateWindowExW: %w", err)
	}
	arrivalWindows.Store(window, arrived)
	return window, nil
}

func arrivalWindowProc(window uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmDeviceChange:
		// lParam names the drives, but the wait asks QueryDosDeviceW anyway.
		if wParam == dbtDeviceArrival {
			if arrived, ok := arrivalWindows.Load(window); ok {
				arrived.(func())()
			}
		}
		return 1
	case wmDestroy:
		arrivalWindows.Delete(window)
		procPostQuitMessage.Call(0)
		return 0
	}
	result, _, _ := procDefWindowProcW.Call(window, uintptr(message), wParam, lParam)
	return result
}

func pumpMessages() {
	var m winMsg
	for {
		// 0 is the WM_QUIT that WM_DESTROY posts, -1 an error.
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}
