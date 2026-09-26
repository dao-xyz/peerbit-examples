//go:build native_mount

package main

import (
	"fmt"
	"math"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

type peerbitFS struct {
	fuse.FileSystemBase
	client *ipcClientPool
	debug  bool
	ready  sync.Once
}

func runNativeMount(endpoint string, mountpoint string, debug bool, ipcConcurrency int) error {
	client, err := newIPCClientPool(endpoint, ipcConcurrency)
	if err != nil {
		return err
	}
	fs := &peerbitFS{
		client: client,
		debug:  debug,
	}
	defer fs.client.close()
	fs.debugf("starting mount endpoint=%s mountpoint=%s ipc-concurrency=%d", endpoint, mountpoint, ipcConcurrency)
	if debug {
		if err := fs.preflight(); err != nil {
			return err
		}
	}
	host := fuse.NewFileSystemHost(fs)
	host.SetCapOpenTrunc(true)
	// On FUSE 3/Linux and WinFsp, ask the kernel to consume the complete stat
	// records supplied by Readdir. Other builds keep both this capability and
	// their IPC listing shape compact.
	host.SetCapReaddirPlus(requestReaddirStats)
	options := nativeMountOptions(runtime.GOOS, debug, ipcConcurrency)
	fs.debugf("mount options=%v", append(options, mountpoint))
	if !host.Mount("", append(options, mountpoint)) {
		return fmt.Errorf("native mount failed for %s", mountpoint)
	}
	return nil
}

func (fs *peerbitFS) debugf(format string, args ...interface{}) {
	if fs.debug {
		fmt.Fprintf(os.Stderr, "peerbit-shared-fs-native: "+format+"\n", args...)
	}
}

func (fs *peerbitFS) preflight() error {
	result, err := fs.client.request("getattr", "/")
	if err != nil {
		return fmt.Errorf("native mount preflight getattr / failed: %w", err)
	}
	mapped, ok := result.(map[string]interface{})
	if !ok {
		return fmt.Errorf("native mount preflight getattr / returned %T", result)
	}
	if mapped["kind"] != "directory" {
		return fmt.Errorf("native mount preflight root is %v, expected directory", mapped["kind"])
	}
	entries, err := fs.client.request("readdir", "/")
	if err != nil {
		return fmt.Errorf("native mount preflight readdir / failed: %w", err)
	}
	if entriesSlice, ok := entries.([]interface{}); ok {
		fs.debugf("preflight ok root entries=%d", len(entriesSlice))
	} else {
		fs.debugf("preflight ok readdir returned %T", entries)
	}
	return nil
}

func (fs *peerbitFS) Init() {
	fs.debugf("fuse init")
	fs.ready.Do(func() {
		fmt.Fprintln(os.Stdout, "peerbit-shared-fs-native ready")
	})
}

func (fs *peerbitFS) Statfs(path string, stat *fuse.Statfs_t) int {
	_ = path
	stat.Bsize = 4096
	stat.Frsize = 4096
	stat.Blocks = 1 << 30
	stat.Bfree = 1 << 29
	stat.Bavail = 1 << 29
	stat.Files = 1 << 30
	stat.Ffree = 1 << 29
	stat.Favail = 1 << 29
	stat.Namemax = 255
	return 0
}

func (fs *peerbitFS) Access(path string, mask uint32) int {
	_ = mask
	result, err := fs.client.request("getattr", path)
	if err != nil {
		return errno(err)
	}
	if _, ok := result.(map[string]interface{}); !ok {
		return -fuse.EIO
	}
	return 0
}

func (fs *peerbitFS) Getattr(path string, stat *fuse.Stat_t, fh uint64) int {
	result, err := fs.client.requestForOptionalHandle(fh, "getattr", path)
	if err != nil {
		return errno(err)
	}
	mapped, ok := result.(map[string]interface{})
	if !ok {
		return -fuse.EIO
	}
	*stat = statFromResult(mapped)
	return 0
}

func (fs *peerbitFS) Opendir(path string) (int, uint64) {
	result, err := fs.client.request("getattr", path)
	if err != nil {
		return errno(err), ^uint64(0)
	}
	mapped, ok := result.(map[string]interface{})
	if !ok {
		return -fuse.EIO, ^uint64(0)
	}
	if mapped["kind"] != "directory" {
		return -fuse.ENOTDIR, ^uint64(0)
	}
	return 0, 0
}

func (fs *peerbitFS) Readdir(path string, fill func(name string, stat *fuse.Stat_t, ofst int64) bool, ofst int64, fh uint64) int {
	_ = ofst
	_ = fh
	args := []interface{}{path}
	if requestReaddirStats {
		args = append(args, map[string]interface{}{"includeStats": true})
	}
	result, err := fs.client.request("readdir", args...)
	if err != nil {
		return errno(err)
	}
	entries, ok := result.([]interface{})
	if !ok {
		return -fuse.EIO
	}
	fill(".", nil, 0)
	fill("..", nil, 0)
	for _, entry := range entries {
		mapped, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := mapped["name"].(string)
		if name == "" {
			continue
		}
		if !fill(name, validatedDirentStat(path, name, mapped), 0) {
			break
		}
	}
	return 0
}

func (fs *peerbitFS) Releasedir(path string, fh uint64) int {
	_ = path
	_ = fh
	return 0
}

func (fs *peerbitFS) Fsyncdir(path string, datasync bool, fh uint64) int {
	_ = path
	_ = datasync
	_ = fh
	return 0
}

func (fs *peerbitFS) Open(path string, flags int) (int, uint64) {
	handle, err := fs.client.open(path, flags)
	if err != nil {
		return errno(err), ^uint64(0)
	}
	return 0, handle
}

func (fs *peerbitFS) Mknod(path string, mode uint32, dev uint64) int {
	_ = mode
	_ = dev
	handle, err := fs.client.open(path, map[string]interface{}{
		"write":          true,
		"create":         true,
		"exclusive":      true,
		"releaseFailure": "discard",
	})
	if err != nil {
		return errno(err)
	}
	err = fs.client.release(handle)
	return errno(err)
}

func (fs *peerbitFS) Create(path string, flags int, mode uint32) (int, uint64) {
	_ = mode
	handle, err := fs.client.open(path, flags)
	if err != nil {
		return errno(err), ^uint64(0)
	}
	return 0, handle
}

func (fs *peerbitFS) Truncate(path string, size int64, fh uint64) int {
	// cgofuse passes ^uint64(0) when no file handle is associated with the
	// truncate (path-based SETATTR).
	if fh != ^uint64(0) {
		_, err := fs.client.requestForHandle(fh, "truncate", size)
		return errno(err)
	}
	_, err := fs.client.request("truncate", path, size)
	return errno(err)
}

func (fs *peerbitFS) Read(path string, buff []byte, ofst int64, fh uint64) int {
	_ = path
	result, err := fs.client.requestForHandle(fh, "read", len(buff), ofst)
	if err != nil {
		return errno(err)
	}
	bytes, ok := result.([]byte)
	if !ok {
		return -fuse.EIO
	}
	return copy(buff, bytes)
}

func (fs *peerbitFS) Write(path string, buff []byte, ofst int64, fh uint64) int {
	_ = path
	result, err := fs.client.requestForHandle(fh, "write", buff, ofst)
	if err != nil {
		return errno(err)
	}
	return int(uint64FromResult(result))
}

func (fs *peerbitFS) Flush(path string, fh uint64) int {
	_ = path
	_, err := fs.client.requestForHandle(fh, "flush")
	return errno(err)
}

func (fs *peerbitFS) Release(path string, fh uint64) int {
	_ = path
	err := fs.client.release(fh)
	return errno(err)
}

func (fs *peerbitFS) Fsync(path string, datasync bool, fh uint64) int {
	_ = path
	_ = datasync
	_, err := fs.client.requestForHandle(fh, "fsync")
	return errno(err)
}

func (fs *peerbitFS) Mkdir(path string, mode uint32) int {
	_ = mode
	_, err := fs.client.request("mkdir", path)
	code := errno(err)
	fs.debugf("mkdir path=%s code=%d err=%v", path, code, err)
	return code
}

func (fs *peerbitFS) Chmod(path string, mode uint32) int {
	_ = path
	_ = mode
	return -fuse.ENOSYS
}

func (fs *peerbitFS) Chown(path string, uid uint32, gid uint32) int {
	_ = path
	_ = uid
	_ = gid
	return -fuse.ENOSYS
}

func (fs *peerbitFS) Utimens(path string, tmsp []fuse.Timespec) int {
	_ = path
	_ = tmsp
	return -fuse.ENOSYS
}

func (fs *peerbitFS) Rmdir(path string) int {
	_, err := fs.client.request("rmdir", path)
	return errno(err)
}

func (fs *peerbitFS) Rename(oldpath string, newpath string) int {
	_, err := fs.client.request("rename", oldpath, newpath)
	return errno(err)
}

func (fs *peerbitFS) Unlink(path string) int {
	_, err := fs.client.request("unlink", path)
	return errno(err)
}

func statFromResult(result map[string]interface{}) fuse.Stat_t {
	mode := nativeStatMode(uint32(uint64Field(result, "mode")))
	mtime := msToTimespec(uint64Field(result, "mtimeMs"))
	ctime := msToTimespec(uint64Field(result, "ctimeMs"))
	return fuse.Stat_t{
		Mode:    mode,
		Nlink:   uint32(uint64Field(result, "nlink")),
		Uid:     uint32(uint64Field(result, "uid")),
		Gid:     uint32(uint64Field(result, "gid")),
		Size:    int64(uint64Field(result, "size")),
		Atim:    mtime,
		Mtim:    mtime,
		Ctim:    ctime,
		Blksize: 4096,
		Blocks:  int64(math.Ceil(float64(uint64Field(result, "size")) / 512)),
	}
}

const maxSafeJSONInteger = uint64(1<<53 - 1)

func childPath(parent string, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return strings.TrimSuffix(parent, "/") + "/" + name
}

// validatedDirentStat accepts only a complete, internally consistent stat
// record. Missing or malformed metadata returns nil so the native host can use
// its ordinary lookup/getattr behavior.
func validatedDirentStat(parent string, name string, entry map[string]interface{}) *fuse.Stat_t {
	raw, exists := entry["stat"]
	if !exists || raw == nil {
		return nil
	}
	result, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}

	kind, ok := entry["kind"].(string)
	if !ok || (kind != "directory" && kind != "file") {
		return nil
	}
	expectedPath := childPath(parent, name)
	if statKind, exists := result["kind"]; exists && statKind != kind {
		return nil
	}
	if statPath, exists := result["path"]; exists {
		path, ok := statPath.(string)
		if !ok || path != expectedPath {
			return nil
		}
	}

	mode, ok := boundedUint64Field(result, "mode", uint64(^uint32(0)))
	if !ok {
		return nil
	}
	expectedType := uint32(statModeRegular)
	if kind == "directory" {
		expectedType = uint32(statModeDirectory)
	}
	if uint32(mode)&statModeTypeMask != expectedType {
		return nil
	}

	size, ok := boundedUint64Field(result, "size", maxSafeJSONInteger)
	if !ok || (kind == "directory" && size != 0) {
		return nil
	}
	if _, ok := boundedUint64Field(result, "mtimeMs", maxSafeJSONInteger); !ok {
		return nil
	}
	if _, ok := boundedUint64Field(result, "ctimeMs", maxSafeJSONInteger); !ok {
		return nil
	}
	nlink, ok := boundedUint64Field(result, "nlink", uint64(^uint32(0)))
	if !ok || nlink == 0 {
		return nil
	}
	for _, field := range []string{"uid", "gid"} {
		if _, exists := result[field]; exists {
			if _, ok := boundedUint64Field(result, field, uint64(^uint32(0))); !ok {
				return nil
			}
		}
	}

	// statFromResult consumes only the validated numeric fields and applies the
	// same platform mode policy as ordinary getattr.
	stat := statFromResult(result)
	return &stat
}

func boundedUint64Field(result map[string]interface{}, key string, max uint64) (uint64, bool) {
	value, exists := result[key]
	if !exists {
		return 0, false
	}
	return boundedUint64(value, max)
}

func boundedUint64(value interface{}, max uint64) (uint64, bool) {
	var parsed uint64
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed < 0 || math.Trunc(typed) != typed || typed > float64(max) {
			return 0, false
		}
		parsed = uint64(typed)
	case int:
		if typed < 0 {
			return 0, false
		}
		parsed = uint64(typed)
	case int64:
		if typed < 0 {
			return 0, false
		}
		parsed = uint64(typed)
	case uint64:
		parsed = typed
	default:
		return 0, false
	}
	if parsed > max {
		return 0, false
	}
	return parsed, true
}

func msToTimespec(ms uint64) fuse.Timespec {
	return fuse.NewTimespec(time.Unix(int64(ms/1000), int64(ms%1000)*int64(time.Millisecond)))
}

func uint64Field(result map[string]interface{}, key string) uint64 {
	return uint64FromResult(result[key])
}

func uint64FromResult(value interface{}) uint64 {
	switch typed := value.(type) {
	case float64:
		return uint64(typed)
	case int:
		return uint64(typed)
	case int64:
		return uint64(typed)
	case uint64:
		return typed
	default:
		return 0
	}
}

func errno(err error) int {
	if err == nil {
		return 0
	}
	if ipc, ok := err.(*ipcError); ok {
		switch ipc.Code {
		case "ENOENT":
			return -fuse.ENOENT
		case "EAGAIN":
			return -fuse.EAGAIN
		case "EEXIST":
			return -fuse.EEXIST
		case "EISDIR":
			return -fuse.EISDIR
		case "ENOTDIR":
			return -fuse.ENOTDIR
		case "EACCES":
			return -fuse.EACCES
		case "EBADF":
			return -fuse.EBADF
		case "EINVAL":
			return -fuse.EINVAL
		case "ENOTEMPTY":
			return -fuse.ENOTEMPTY
		case "EROFS":
			return -fuse.EROFS
		}
	}
	fmt.Fprintf(os.Stderr, "peerbit-shared-fs-native: %v\n", err)
	return -fuse.EIO
}
