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
	"unicode/utf8"

	"github.com/winfsp/cgofuse/fuse"
)

type peerbitFS struct {
	fuse.FileSystemBase
	client  *ipcClient
	debug   bool
	profile *mountProfiler
	ready   sync.Once
}

// requestReaddirStats enables readdir-plus and per-entry listing stats only on
// Windows, where WinFsp consumes them. cgofuse loads libfuse3.so.3 (3.16 and
// older), whose high-level API hands the Linux kernel those stats with node ID
// 0, which it ignores, while pinning a lookup per entry; revisit this if it
// loads libfuse3.so.4 (3.17.1+), which looks the entries up. FUSE 2 (macOS)
// has no readdir-plus. Elsewhere Readdir passes only the type bits, which the
// host needs for d_type.
const requestReaddirStats = runtime.GOOS == "windows"

func runNativeMount(endpoint string, mountpoint string, debug bool, profile *mountProfiler) error {
	fs := &peerbitFS{
		client:  newIPCClient(endpoint, ipcClientOptions{profile: profile}),
		debug:   debug,
		profile: profile,
	}
	defer fs.client.close()
	fs.debugf("starting mount endpoint=%s mountpoint=%s", endpoint, mountpoint)
	// Negotiate before mounting: an incompatible server then fails the mount
	// at startup instead of every later filesystem operation with EIO.
	if err := fs.client.negotiate(); err != nil {
		return fmt.Errorf("native adapter could not connect to %s: %w", endpoint, err)
	}
	if debug {
		if err := fs.preflight(); err != nil {
			return err
		}
	}
	host := fuse.NewFileSystemHost(fs)
	host.SetCapOpenTrunc(true)
	host.SetCapReaddirPlus(requestReaddirStats)
	options := nativeMountOptions(runtime.GOOS, debug)
	fs.debugf("mount options=%v", append(options, mountpoint))
	if !host.Mount("", append(options, mountpoint)) {
		return fmt.Errorf("native mount failed for %s", mountpoint)
	}
	return nil
}

// beginCallback returns nil when profiling is off, so the disabled path adds
// only a nil check. The returned finisher records the callback's FUSE result;
// a negative result carries the errno and its portable name.
func (fs *peerbitFS) beginCallback(operation string) func(int) {
	if fs.profile == nil {
		return nil
	}
	return fs.beginCallbackRecord(mountProfileRecord{operation: operation})
}

// beginIOCallback also records the requested byte count and file offset.
func (fs *peerbitFS) beginIOCallback(operation string, size int, offset int64) func(int) {
	if fs.profile == nil {
		return nil
	}
	return fs.beginCallbackRecord(mountProfileRecord{
		operation: operation,
		fields:    profileBytes | profileOffset,
		bytes:     int64(size),
		offset:    offset,
	})
}

func (fs *peerbitFS) beginCallbackRecord(record mountProfileRecord) func(int) {
	started := time.Now()
	return func(result int) {
		record.phase = "native.callback"
		record.startUnixNs = started.UnixNano()
		record.durationNs = time.Since(started).Nanoseconds()
		record.ok = result >= 0
		if result < 0 {
			record.fields |= profileErrno
			record.errno = result
			if name := errnoName(result); name != "" {
				record.fields |= profileCode
				record.code = name
			}
		}
		fs.profile.emit(record)
	}
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
	if finish := fs.beginCallback("init"); finish != nil {
		defer finish(0)
	}
	// Keep the post-unmount SIGINT the CLI sends from killing the adapter
	// before the profile is flushed (no-op when profiling is off).
	fs.profile.holdShutdownSignals()
	fs.debugf("fuse init")
	fs.ready.Do(func() {
		fmt.Fprintln(os.Stdout, "peerbit-shared-fs-native ready")
	})
}

func (fs *peerbitFS) Statfs(path string, stat *fuse.Statfs_t) (code int) {
	if finish := fs.beginCallback("statfs"); finish != nil {
		defer func() { finish(code) }()
	}
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

func (fs *peerbitFS) Access(path string, mask uint32) (code int) {
	if finish := fs.beginCallback("access"); finish != nil {
		defer func() { finish(code) }()
	}
	result, err := fs.client.request("getattr", path)
	if err != nil {
		return errno(err)
	}
	mapped, ok := result.(map[string]interface{})
	if !ok {
		return -fuse.EIO
	}
	// The mount runs without default_permissions, so access(2) (test -x)
	// lands here; agree with the kernel's execve check on the exec bit.
	mode := uint32(uint64Field(mapped, "mode"))
	if runtime.GOOS != "windows" && mask&fuse.X_OK != 0 &&
		mode&statModeTypeMask == statModeRegular && mode&0o111 == 0 {
		return -fuse.EACCES
	}
	return 0
}

func (fs *peerbitFS) Getattr(path string, stat *fuse.Stat_t, fh uint64) (code int) {
	if finish := fs.beginCallback("getattr"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = fh
	result, err := fs.client.request("getattr", path)
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

func (fs *peerbitFS) Opendir(path string) (code int, handle uint64) {
	if finish := fs.beginCallback("opendir"); finish != nil {
		defer func() { finish(code) }()
	}
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

func (fs *peerbitFS) Readdir(path string, fill func(name string, stat *fuse.Stat_t, ofst int64) bool, ofst int64, fh uint64) (code int) {
	if finish := fs.beginCallback("readdir"); finish != nil {
		defer func() { finish(code) }()
	}
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
		stat := &fuse.Stat_t{Mode: direntType(mapped)}
		if requestReaddirStats {
			stat = validatedDirentStat(path, name, mapped)
		}
		if !fill(name, stat, 0) {
			break
		}
	}
	return 0
}

func (fs *peerbitFS) Releasedir(path string, fh uint64) (code int) {
	if finish := fs.beginCallback("releasedir"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_ = fh
	return 0
}

func (fs *peerbitFS) Fsyncdir(path string, datasync bool, fh uint64) (code int) {
	if finish := fs.beginCallback("fsyncdir"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_ = datasync
	_ = fh
	return 0
}

func (fs *peerbitFS) Open(path string, flags int) (code int, handle uint64) {
	if finish := fs.beginCallback("open"); finish != nil {
		defer func() { finish(code) }()
	}
	result, err := fs.client.request("open", path, flags)
	if err != nil {
		return openErrno(errno(err), runtime.GOOS), ^uint64(0)
	}
	return 0, uint64FromResult(result)
}

// linuxESTALE is ESTALE on Linux; cgofuse defines no constant for it.
const linuxESTALE = 116

// openErrno answers ESTALE on Linux where the daemon says ENOENT. The kernel
// sends OPEN only for a name its dentry cache still binds to a file, and names
// stay cached for up to 0.1 s (linuxKernelCacheOptions), so ENOENT here means
// another peer removed or renamed the path within that window. An open with
// O_CREAT but without O_EXCL reaches Open with O_CREAT stripped; ESTALE makes
// the kernel repeat the open once with a fresh LOOKUP, which then creates the
// file (or fails with ENOENT when there is no O_CREAT). Only a second removal
// racing that retry surfaces ESTALE to the caller. Every other callback keeps
// ENOENT: Getattr also answers LOOKUP, where ENOENT is the negative answer;
// Create runs only after a negative lookup, so ENOENT there is a missing
// parent; and for the rest (access, opendir, truncate, unlink, rename, ...)
// a removed path is exactly what ENOENT reports.
func openErrno(code int, goos string) int {
	if goos == "linux" && code == -fuse.ENOENT {
		return -linuxESTALE
	}
	return code
}

func (fs *peerbitFS) Mknod(path string, mode uint32, dev uint64) (code int) {
	if finish := fs.beginCallback("mknod"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = dev
	result, err := fs.openCreate(path, map[string]interface{}{
		"write":          true,
		"create":         true,
		"exclusive":      true,
		"releaseFailure": "discard",
	}, mode)
	if err != nil {
		return errno(err)
	}
	_, err = fs.client.request("release", uint64FromResult(result))
	return errno(err)
}

func (fs *peerbitFS) Create(path string, flags int, mode uint32) (code int, handle uint64) {
	if finish := fs.beginCallback("create"); finish != nil {
		defer func() { finish(code) }()
	}
	result, err := fs.openCreate(path, flags, mode)
	if err != nil {
		return errno(err), ^uint64(0)
	}
	return 0, uint64FromResult(result)
}

// openCreate passes the create mode (the backend keeps its exec bit) as
// open's third argument. WinFsp derives create modes from ACLs, so Windows
// sends none and files created there are never executable.
func (fs *peerbitFS) openCreate(path string, flags interface{}, mode uint32) (interface{}, error) {
	if runtime.GOOS == "windows" {
		return fs.client.request("open", path, flags)
	}
	return fs.client.request("open", path, flags, mode&0o777)
}

func (fs *peerbitFS) Truncate(path string, size int64, fh uint64) (code int) {
	if finish := fs.beginCallback("truncate"); finish != nil {
		defer func() { finish(code) }()
	}
	// cgofuse passes ^uint64(0) when no file handle is associated with the
	// truncate (path-based SETATTR).
	if fh != ^uint64(0) {
		_, err := fs.client.request("truncate", fh, size)
		return errno(err)
	}
	_, err := fs.client.request("truncate", path, size)
	return errno(err)
}

func (fs *peerbitFS) Read(path string, buff []byte, ofst int64, fh uint64) (code int) {
	if finish := fs.beginIOCallback("read", len(buff), ofst); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	result, err := fs.client.request("read", fh, len(buff), ofst)
	if err != nil {
		return errno(err)
	}
	bytes, ok := result.([]byte)
	if !ok {
		return -fuse.EIO
	}
	return copy(buff, bytes)
}

func (fs *peerbitFS) Write(path string, buff []byte, ofst int64, fh uint64) (code int) {
	if finish := fs.beginIOCallback("write", len(buff), ofst); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	result, err := fs.client.request("write", fh, buff, ofst)
	if err != nil {
		return errno(err)
	}
	return int(uint64FromResult(result))
}

func (fs *peerbitFS) Flush(path string, fh uint64) (code int) {
	if finish := fs.beginCallback("flush"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_, err := fs.client.request("flush", fh)
	return errno(err)
}

func (fs *peerbitFS) Release(path string, fh uint64) (code int) {
	if finish := fs.beginCallback("release"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_, err := fs.client.request("release", fh)
	return errno(err)
}

func (fs *peerbitFS) Fsync(path string, datasync bool, fh uint64) (code int) {
	if finish := fs.beginCallback("fsync"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_ = datasync
	_, err := fs.client.request("fsync", fh)
	return errno(err)
}

func (fs *peerbitFS) Mkdir(path string, mode uint32) (code int) {
	if finish := fs.beginCallback("mkdir"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = mode
	_, err := fs.client.request("mkdir", path)
	code = errno(err)
	fs.debugf("mkdir path=%s code=%d err=%v", path, code, err)
	return code
}

// Chmod keeps only the exec bit (in the backend). On Windows it is a no-op,
// so an ACL edit (SetSecurity) cannot clear a POSIX peer's exec bit.
func (fs *peerbitFS) Chmod(path string, mode uint32) (code int) {
	if finish := fs.beginCallback("chmod"); finish != nil {
		defer func() { finish(code) }()
	}
	if runtime.GOOS == "windows" {
		return 0
	}
	_, err := fs.client.request("setattr", path, map[string]interface{}{"mode": mode & 0o7777})
	return errno(err)
}

// Chown succeeds without storing anything: shared-fs has no owners.
func (fs *peerbitFS) Chown(path string, uid uint32, gid uint32) (code int) {
	if finish := fs.beginCallback("chown"); finish != nil {
		defer func() { finish(code) }()
	}
	_ = path
	_ = uid
	_ = gid
	return 0
}

// Utimens stores mtime in milliseconds and ignores atime. cgofuse maps only a
// both-NOW pair and compares against the Linux sentinels on every OS, so the
// macOS UTIME_NOW (-1) and UTIME_OMIT (-2) arrive raw: -1 is the clock, and
// any other nanosecond value out of range is an omitted mtime (touch -a).
func (fs *peerbitFS) Utimens(path string, tmsp []fuse.Timespec) (code int) {
	if finish := fs.beginCallback("utimens"); finish != nil {
		defer func() { finish(code) }()
	}
	if len(tmsp) < 2 {
		return 0
	}
	t := tmsp[1]
	if t.Nsec == fuse.UTIME_NOW || t.Nsec == -1 {
		t = fuse.Now()
	} else if t.Nsec < 0 || t.Nsec >= int64(time.Second) {
		return 0
	}
	ms := t.Sec*1000 + t.Nsec/int64(time.Millisecond)
	if t.Sec < 0 || t.Sec > int64(maxSafeJSONInteger/1000) || ms > int64(maxSafeJSONInteger) {
		return -fuse.EINVAL
	}
	_, err := fs.client.request("setattr", path, map[string]interface{}{"mtimeMs": ms})
	return errno(err)
}

func (fs *peerbitFS) Symlink(target string, newpath string) (code int) {
	if finish := fs.beginCallback("symlink"); finish != nil {
		defer func() { finish(code) }()
	}
	// Go's JSON encoder would store U+FFFD for invalid UTF-8; the library
	// validates everything else about the target.
	if !utf8.ValidString(target) {
		return -fuse.EINVAL
	}
	_, err := fs.client.request("symlink", target, newpath)
	return errno(err)
}

func (fs *peerbitFS) Readlink(path string) (code int, target string) {
	if finish := fs.beginCallback("readlink"); finish != nil {
		defer func() { finish(code) }()
	}
	// WinFsp probes readlink("/") at mount to enable symlinks.
	if path == "/" {
		return -fuse.EINVAL, ""
	}
	result, err := fs.client.request("readlink", path)
	if err != nil {
		return errno(err), ""
	}
	target, ok := result.(string)
	if !ok {
		return -fuse.EIO, ""
	}
	return 0, target
}

func (fs *peerbitFS) Rmdir(path string) (code int) {
	if finish := fs.beginCallback("rmdir"); finish != nil {
		defer func() { finish(code) }()
	}
	_, err := fs.client.request("rmdir", path)
	return errno(err)
}

func (fs *peerbitFS) Rename(oldpath string, newpath string) (code int) {
	if finish := fs.beginCallback("rename"); finish != nil {
		defer func() { finish(code) }()
	}
	_, err := fs.client.request("rename", oldpath, newpath)
	return errno(err)
}

func (fs *peerbitFS) Unlink(path string) (code int) {
	if finish := fs.beginCallback("unlink"); finish != nil {
		defer func() { finish(code) }()
	}
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
		Uid:     ownerField(result, "uid", mountUID),
		Gid:     ownerField(result, "gid", mountGID),
		Size:    int64(uint64Field(result, "size")),
		Atim:    mtime,
		Mtim:    mtime,
		Ctim:    ctime,
		Blksize: 4096,
		Blocks:  int64(math.Ceil(float64(uint64Field(result, "size")) / 512)),
	}
}

// The mounting user owns every file off Windows (git refuses a repository
// owned by another user). On Windows the uid=-1,gid=-1 mount option names
// the owner instead.
var mountUID, mountGID = uint32(os.Getuid()), uint32(os.Getgid())

func ownerField(result map[string]interface{}, key string, fallback uint32) uint32 {
	if _, exists := result[key]; !exists && runtime.GOOS != "windows" {
		return fallback
	}
	return uint32(uint64Field(result, key))
}

const maxSafeJSONInteger = uint64(1<<53 - 1)

func childPath(parent string, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return strings.TrimSuffix(parent, "/") + "/" + name
}

// direntType returns the stat type bits of a listed entry's kind, or 0 for an
// unknown kind.
func direntType(entry map[string]interface{}) uint32 {
	switch entry["kind"] {
	case "directory":
		return statModeDirectory
	case "file":
		return statModeRegular
	case "symlink":
		return statModeSymlink
	}
	return 0
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

	kind, _ := entry["kind"].(string)
	expectedType := direntType(entry)
	if expectedType == 0 {
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
	if uint32(mode)&statModeTypeMask != expectedType {
		return nil
	}

	size, ok := boundedUint64Field(result, "size", maxSafeJSONInteger)
	if !ok || (kind == "directory" && size != 0) || (kind == "symlink" && size == 0) {
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

// errnoName names a negative FUSE result portably, so profile consumers can
// classify failures without platform-specific errno numbers.
func errnoName(result int) string {
	if runtime.GOOS == "linux" && -result == linuxESTALE {
		return "ESTALE"
	}
	switch -result {
	case fuse.ENOENT:
		return "ENOENT"
	case fuse.EAGAIN:
		return "EAGAIN"
	case fuse.EIO:
		return "EIO"
	case fuse.EEXIST:
		return "EEXIST"
	case fuse.EISDIR:
		return "EISDIR"
	case fuse.ENOTDIR:
		return "ENOTDIR"
	case fuse.EACCES:
		return "EACCES"
	case fuse.EBADF:
		return "EBADF"
	case fuse.EINVAL:
		return "EINVAL"
	case fuse.ENOTEMPTY:
		return "ENOTEMPTY"
	case fuse.EROFS:
		return "EROFS"
	case fuse.ENOSYS:
		return "ENOSYS"
	}
	return ""
}
