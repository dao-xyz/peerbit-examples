//go:build native_mount

package main

import (
	"fmt"
	"math"
	"os"
	"sync"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

type peerbitFS struct {
	fuse.FileSystemBase
	client *ipcClient
	debug  bool
	ready  sync.Once
}

func runNativeMount(endpoint string, mountpoint string, debug bool) error {
	fs := &peerbitFS{
		client: newIPCClient(endpoint),
		debug:  debug,
	}
	host := fuse.NewFileSystemHost(fs)
	host.SetCapOpenTrunc(true)
	options := []string{"-s"}
	if debug {
		options = append(options, "-d")
	}
	if !host.Mount(mountpoint, options) {
		return fmt.Errorf("native mount failed for %s", mountpoint)
	}
	return nil
}

func (fs *peerbitFS) Init() {
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
	result, err := fs.client.request("readdir", path)
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
		if !fill(name, nil, 0) {
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
	result, err := fs.client.request("open", path, flags)
	if err != nil {
		return errno(err), ^uint64(0)
	}
	return 0, uint64FromResult(result)
}

func (fs *peerbitFS) Mknod(path string, mode uint32, dev uint64) int {
	_ = mode
	_ = dev
	result, err := fs.client.request("open", path, map[string]interface{}{
		"write":    true,
		"create":   true,
		"truncate": true,
	})
	if err != nil {
		return errno(err)
	}
	_, err = fs.client.request("release", uint64FromResult(result))
	return errno(err)
}

func (fs *peerbitFS) Create(path string, flags int, mode uint32) (int, uint64) {
	_ = flags
	_ = mode
	result, err := fs.client.request("open", path, map[string]interface{}{
		"write":    true,
		"create":   true,
		"truncate": true,
	})
	if err != nil {
		return errno(err), ^uint64(0)
	}
	return 0, uint64FromResult(result)
}

func (fs *peerbitFS) Truncate(path string, size int64, fh uint64) int {
	if fh != 0 {
		if size == 0 {
			_, err := fs.client.request("write", fh, []byte{}, 0)
			return errno(err)
		}
		return -fuse.ENOTSUP
	}
	if size != 0 {
		return -fuse.ENOTSUP
	}
	result, err := fs.client.request("open", path, map[string]interface{}{
		"write":    true,
		"create":   true,
		"truncate": true,
	})
	if err != nil {
		return errno(err)
	}
	_, err = fs.client.request("release", uint64FromResult(result))
	return errno(err)
}

func (fs *peerbitFS) Read(path string, buff []byte, ofst int64, fh uint64) int {
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

func (fs *peerbitFS) Write(path string, buff []byte, ofst int64, fh uint64) int {
	_ = path
	result, err := fs.client.request("write", fh, buff, ofst)
	if err != nil {
		return errno(err)
	}
	return int(uint64FromResult(result))
}

func (fs *peerbitFS) Flush(path string, fh uint64) int {
	_ = path
	_, err := fs.client.request("flush", fh)
	return errno(err)
}

func (fs *peerbitFS) Release(path string, fh uint64) int {
	_ = path
	_, err := fs.client.request("release", fh)
	return errno(err)
}

func (fs *peerbitFS) Fsync(path string, datasync bool, fh uint64) int {
	_ = path
	_ = datasync
	_, err := fs.client.request("fsync", fh)
	return errno(err)
}

func (fs *peerbitFS) Mkdir(path string, mode uint32) int {
	_ = mode
	_, err := fs.client.request("mkdir", path)
	return errno(err)
}

func (fs *peerbitFS) Chmod(path string, mode uint32) int {
	_ = path
	_ = mode
	return 0
}

func (fs *peerbitFS) Chown(path string, uid uint32, gid uint32) int {
	_ = path
	_ = uid
	_ = gid
	return 0
}

func (fs *peerbitFS) Utimens(path string, tmsp []fuse.Timespec) int {
	_ = path
	_ = tmsp
	return 0
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
	mode := uint32(uint64Field(result, "mode"))
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
		case "EROFS":
			return -fuse.EROFS
		}
	}
	return -fuse.EIO
}
