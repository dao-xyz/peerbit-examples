package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

type merkleGoldenBlock struct {
	BytesHex     string              `json:"bytesHex"`
	Level        uint8               `json:"level"`
	Slots        []uint8             `json:"slots"`
	Children     []merkleGoldenChild `json:"children"`
	HashInputHex string              `json:"hashInputHex"`
	HashHex      string              `json:"hashHex"`
	ID           string              `json:"id"`
}

type merkleGoldenChild struct {
	FillByte uint8  `json:"fillByte"`
	Length   uint32 `json:"length"`
	HashHex  string `json:"hashHex"`
}

type merkleGoldenRoot struct {
	LeafSize     uint32 `json:"leafSize"`
	Size         string `json:"size"`
	RootLevel    uint8  `json:"rootLevel"`
	RootHashHex  string `json:"rootHashHex"`
	HashInputHex string `json:"hashInputHex"`
	HashHex      string `json:"hashHex"`
}

type merkleGoldenFileVersion struct {
	Variant              string   `json:"variant"`
	ID                   string   `json:"id"`
	NodeID               string   `json:"nodeId"`
	ParentVersionIDs     []string `json:"parentVersionIds"`
	CausalDepth          string   `json:"causalDepth"`
	CreatedAt            string   `json:"createdAt"`
	AuthorKey            string   `json:"authorKey"`
	MachineLabel         string   `json:"machineLabel"`
	ConflictResolution   bool     `json:"conflictResolution"`
	ChangesetID          string   `json:"changesetId"`
	LegacyWholeSHA256Hex string   `json:"legacyWholeSha256Hex"`
	RootBlockRefs        []string `json:"rootBlockRefs"`
	BorshHex             string   `json:"borshHex"`
}

type merkleGoldenFileVersionIndex struct {
	Variant   string `json:"variant"`
	Kind      string `json:"kind"`
	TreeLevel uint8  `json:"treeLevel"`
	BorshHex  string `json:"borshHex"`
}

type merkleGoldenVectors struct {
	Format           string                       `json:"format"`
	IntegerEncoding  string                       `json:"integerEncoding"`
	BitmapBitOrder   string                       `json:"bitmapBitOrder"`
	IDEncoding       string                       `json:"idEncoding"`
	Data             merkleGoldenBlock            `json:"data"`
	Tree             merkleGoldenBlock            `json:"tree"`
	PresentRoot      merkleGoldenRoot             `json:"presentRoot"`
	FileVersion      merkleGoldenFileVersion      `json:"fileVersion"`
	FileVersionIndex merkleGoldenFileVersionIndex `json:"fileVersionIndex"`
	SparseRoot       merkleGoldenRoot             `json:"sparseRoot"`
}

func readMerkleGoldenVectors(t *testing.T) merkleGoldenVectors {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join("..", "merkle-v1-golden-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors merkleGoldenVectors
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Format != "peerbit-shared-fs-merkle-v1-golden-v1" {
		t.Fatalf("unknown golden-vector format %q", vectors.Format)
	}
	if vectors.IDEncoding != "unpadded-base64url" {
		t.Fatalf("unknown id encoding %q", vectors.IDEncoding)
	}
	if vectors.IntegerEncoding != "borsh-little-endian" {
		t.Fatalf("unknown integer encoding %q", vectors.IntegerEncoding)
	}
	if vectors.BitmapBitOrder != "slot i is least-significant bit (i & 7) of byte (i >>> 3)" {
		t.Fatalf("unknown bitmap bit order %q", vectors.BitmapBitOrder)
	}
	return vectors
}

func decodeGoldenHex(t *testing.T, name, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	return decoded
}

func appendU32LE(target []byte, value uint32) []byte {
	var encoded [4]byte
	binary.LittleEndian.PutUint32(encoded[:], value)
	return append(target, encoded[:]...)
}

func appendU64LE(target []byte, value uint64) []byte {
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], value)
	return append(target, encoded[:]...)
}

func appendBorshString(target []byte, value string) []byte {
	target = appendU32LE(target, uint32(len([]byte(value))))
	return append(target, []byte(value)...)
}

func appendBorshStringVector(target []byte, values []string) []byte {
	target = appendU32LE(target, uint32(len(values)))
	for _, value := range values {
		target = appendBorshString(target, value)
	}
	return target
}

func assertGoldenHash(t *testing.T, name string, input []byte, inputHex, hashHex string) [32]byte {
	t.Helper()
	if got := hex.EncodeToString(input); got != inputHex {
		t.Fatalf("%s preimage mismatch\n got: %s\nwant: %s", name, got, inputHex)
	}
	digest := sha256.Sum256(input)
	if got := hex.EncodeToString(digest[:]); got != hashHex {
		t.Fatalf("%s hash mismatch\n got: %s\nwant: %s", name, got, hashHex)
	}
	return digest
}

func goldenDataHash(t *testing.T, name string, data []byte, expected string) [32]byte {
	t.Helper()
	input := append([]byte{}, []byte("peerbit-shared-fs/data/v1")...)
	input = appendU32LE(input, uint32(len(data)))
	input = append(input, data...)
	digest := sha256.Sum256(input)
	if got := hex.EncodeToString(digest[:]); got != expected {
		t.Fatalf("%s hash mismatch: got %s, want %s", name, got, expected)
	}
	return digest
}

func rootHashInput(t *testing.T, vector merkleGoldenRoot) []byte {
	t.Helper()
	size, err := strconv.ParseUint(vector.Size, 10, 64)
	if err != nil {
		t.Fatalf("parse root size: %v", err)
	}
	input := append([]byte{}, []byte("peerbit-shared-fs/file/v1")...)
	input = appendU32LE(input, vector.LeafSize)
	input = appendU64LE(input, size)
	input = append(input, vector.RootLevel)
	if vector.RootHashHex == "" {
		return append(input, 0)
	}
	input = append(input, 1)
	rootHash := decodeGoldenHex(t, "rootHashHex", vector.RootHashHex)
	if len(rootHash) != sha256.Size {
		t.Fatalf("root hash has %d bytes, want %d", len(rootHash), sha256.Size)
	}
	return append(input, rootHash...)
}

func fileVersionWire(t *testing.T, vectors merkleGoldenVectors) []byte {
	t.Helper()
	version := vectors.FileVersion
	if version.Variant != "shared_fs_merkle_file_version_v1" {
		t.Fatalf("unknown file-version variant %q", version.Variant)
	}
	if !strings.HasPrefix(version.ID, "version:") || len(version.ID) == len("version:") || len([]byte(version.ID)) > 256 || !utf8.ValidString(version.ID) {
		t.Fatalf("invalid file-version id %q", version.ID)
	}
	if !strings.HasPrefix(version.NodeID, "file:") || len(version.NodeID) == len("file:") || len([]byte(version.NodeID)) > 256 || !utf8.ValidString(version.NodeID) {
		t.Fatalf("invalid file-version node id %q", version.NodeID)
	}
	if len(version.ParentVersionIDs) > 8_000 {
		t.Fatalf("too many file-version parents: %d", len(version.ParentVersionIDs))
	}
	parents := make(map[string]struct{}, len(version.ParentVersionIDs))
	parentBytes := 0
	for _, parent := range version.ParentVersionIDs {
		if !strings.HasPrefix(parent, "version:") || len(parent) == len("version:") || len([]byte(parent)) > 256 || !utf8.ValidString(parent) {
			t.Fatalf("invalid file-version parent %q", parent)
		}
		if parent == version.ID {
			t.Fatalf("file version names itself as parent")
		}
		if _, exists := parents[parent]; exists {
			t.Fatalf("duplicate file-version parent %q", parent)
		}
		parents[parent] = struct{}{}
		parentBytes += len([]byte(parent))
	}
	if parentBytes > 1024*1024 {
		t.Fatalf("file-version parents use %d bytes", parentBytes)
	}
	causalDepth, err := strconv.ParseUint(version.CausalDepth, 10, 64)
	if err != nil || causalDepth == 0 {
		t.Fatalf("invalid causal depth %q", version.CausalDepth)
	}
	if (len(version.ParentVersionIDs) == 0 && causalDepth != 1) || (len(version.ParentVersionIDs) != 0 && causalDepth < 2) {
		t.Fatalf("causal depth %d is inconsistent with %d parents", causalDepth, len(version.ParentVersionIDs))
	}
	createdAt, err := strconv.ParseUint(version.CreatedAt, 10, 64)
	if err != nil {
		t.Fatalf("invalid createdAt %q", version.CreatedAt)
	}
	if version.AuthorKey == "" || len([]byte(version.AuthorKey)) > 4*1024 || !utf8.ValidString(version.AuthorKey) {
		t.Fatalf("invalid author key")
	}
	if version.MachineLabel == "" || len([]byte(version.MachineLabel)) > 4*1024 || !utf8.ValidString(version.MachineLabel) {
		t.Fatalf("invalid machine label")
	}
	if version.ChangesetID == "" || len(utf16.Encode([]rune(version.ChangesetID))) > 256 || len([]byte(version.ChangesetID)) > 1024 || !utf8.ValidString(version.ChangesetID) {
		t.Fatalf("invalid changeset id")
	}

	size, err := strconv.ParseUint(vectors.PresentRoot.Size, 10, 64)
	if err != nil {
		t.Fatalf("parse file-version size: %v", err)
	}
	rootHash := decodeGoldenHex(t, "fileVersion rootHash", vectors.PresentRoot.RootHashHex)
	contentRoot := decodeGoldenHex(t, "fileVersion contentRoot", vectors.PresentRoot.HashHex)
	legacyHash := decodeGoldenHex(t, "legacyWholeSha256Hex", version.LegacyWholeSHA256Hex)
	if len(rootHash) != sha256.Size || len(contentRoot) != sha256.Size || len(legacyHash) != sha256.Size {
		t.Fatal("file-version hashes must contain exactly 32 bytes")
	}
	computedContentRoot := sha256.Sum256(rootHashInput(t, vectors.PresentRoot))
	if hex.EncodeToString(computedContentRoot[:]) != vectors.PresentRoot.HashHex {
		t.Fatal("file-version content root does not bind its descriptor")
	}
	wantRootRef := "tree2:" + base64.RawURLEncoding.EncodeToString(rootHash)
	if len(version.RootBlockRefs) != 1 || version.RootBlockRefs[0] != wantRootRef {
		t.Fatalf("file-version root refs are %q, want [%q]", version.RootBlockRefs, wantRootRef)
	}

	fields := appendBorshString(nil, version.Variant)
	fields = appendBorshString(fields, version.ID)
	fields = appendBorshString(fields, version.NodeID)
	fields = appendBorshStringVector(fields, version.ParentVersionIDs)
	fields = appendU64LE(fields, causalDepth)
	fields = appendU64LE(fields, size)
	fields = appendU32LE(fields, vectors.PresentRoot.LeafSize)
	fields = append(fields, vectors.PresentRoot.RootLevel)
	fields = append(fields, 1)
	fields = append(fields, rootHash...)
	fields = append(fields, contentRoot...)
	fields = appendU64LE(fields, createdAt)
	fields = appendBorshString(fields, version.AuthorKey)
	fields = appendBorshString(fields, version.MachineLabel)
	if version.ConflictResolution {
		fields = append(fields, 1)
	} else {
		fields = append(fields, 0)
	}
	fields = append(fields, 1)
	fields = appendBorshString(fields, version.ChangesetID)
	fields = append(fields, 1)
	fields = append(fields, legacyHash...)
	return fields
}

func fileVersionIndexWire(t *testing.T, vectors merkleGoldenVectors) []byte {
	t.Helper()
	index := vectors.FileVersionIndex
	version := vectors.FileVersion
	if index.Variant != "shared_fs_merkle_indexable_entry_v1" || index.Kind != "file-version" || index.TreeLevel != 0 {
		t.Fatalf("invalid file-version index discriminator")
	}
	causalDepth, err := strconv.ParseUint(version.CausalDepth, 10, 64)
	if err != nil {
		t.Fatalf("parse index causal depth: %v", err)
	}
	size, err := strconv.ParseUint(vectors.PresentRoot.Size, 10, 64)
	if err != nil {
		t.Fatalf("parse index size: %v", err)
	}
	createdAt, err := strconv.ParseUint(version.CreatedAt, 10, 64)
	if err != nil {
		t.Fatalf("parse index createdAt: %v", err)
	}
	contentRoot := decodeGoldenHex(t, "index contentRoot", vectors.PresentRoot.HashHex)
	if len(contentRoot) != sha256.Size {
		t.Fatal("index content root must contain exactly 32 bytes")
	}

	fields := appendBorshString(nil, index.Variant)
	fields = appendBorshString(fields, version.ID)
	fields = appendBorshString(fields, index.Kind)
	fields = append(fields, 1)
	fields = appendBorshString(fields, version.NodeID)
	fields = appendBorshStringVector(fields, version.RootBlockRefs)
	fields = appendBorshStringVector(fields, version.ParentVersionIDs)
	fields = appendU64LE(fields, causalDepth)
	fields = appendU64LE(fields, size)
	fields = appendU32LE(fields, vectors.PresentRoot.LeafSize)
	fields = append(fields, vectors.PresentRoot.RootLevel)
	fields = append(fields, index.TreeLevel)
	fields = append(fields, 1)
	fields = append(fields, contentRoot...)
	fields = appendU64LE(fields, createdAt)
	fields = append(fields, 1)
	fields = appendBorshString(fields, version.AuthorKey)
	fields = append(fields, 1)
	fields = appendBorshString(fields, version.MachineLabel)
	if version.ConflictResolution {
		fields = append(fields, 1)
	} else {
		fields = append(fields, 0)
	}
	fields = append(fields, 1)
	fields = appendBorshString(fields, version.ChangesetID)
	return fields
}

func TestMerkleV1GoldenVectors(t *testing.T) {
	vectors := readMerkleGoldenVectors(t)

	data := decodeGoldenHex(t, "data.bytesHex", vectors.Data.BytesHex)
	dataInput := append([]byte{}, []byte("peerbit-shared-fs/data/v1")...)
	dataInput = appendU32LE(dataInput, uint32(len(data)))
	dataInput = append(dataInput, data...)
	dataHash := assertGoldenHash(
		t,
		"data",
		dataInput,
		vectors.Data.HashInputHex,
		vectors.Data.HashHex,
	)
	if got := "data2:" + base64.RawURLEncoding.EncodeToString(dataHash[:]); got != vectors.Data.ID {
		t.Fatalf("data id mismatch: got %q, want %q", got, vectors.Data.ID)
	}

	var bitmap [32]byte
	previous := -1
	for _, rawSlot := range vectors.Tree.Slots {
		slot := int(rawSlot)
		if slot <= previous {
			t.Fatalf("tree slots are not strictly ascending at %d", slot)
		}
		bitmap[slot>>3] |= byte(1 << (slot & 7))
		previous = slot
	}
	if len(vectors.Tree.Slots) == 0 {
		t.Fatal("golden tree must not be empty")
	}
	if len(vectors.Tree.Children) != len(vectors.Tree.Slots) {
		t.Fatal("tree child count does not match bitmap population")
	}
	rootSize, err := strconv.ParseUint(vectors.PresentRoot.Size, 10, 64)
	if err != nil {
		t.Fatalf("parse present root size: %v", err)
	}
	if vectors.PresentRoot.RootLevel != vectors.Tree.Level || vectors.Tree.Level != 1 {
		t.Fatal("present root must reference the level-1 golden tree")
	}
	lastSlot := uint64(vectors.Tree.Slots[len(vectors.Tree.Slots)-1])
	lastLength := uint64(vectors.Tree.Children[len(vectors.Tree.Children)-1].Length)
	if want := lastSlot*uint64(vectors.PresentRoot.LeafSize) + lastLength; rootSize != want {
		t.Fatalf("present root size is %d, want %d from its final child", rootSize, want)
	}
	treeInput := append([]byte{}, []byte("peerbit-shared-fs/tree/v1")...)
	treeInput = append(treeInput, vectors.Tree.Level)
	treeInput = append(treeInput, bitmap[:]...)
	treeInput = appendU32LE(treeInput, uint32(len(vectors.Tree.Children)))
	for index, childVector := range vectors.Tree.Children {
		isFinal := index == len(vectors.Tree.Children)-1
		if childVector.Length == 0 || childVector.Length > vectors.PresentRoot.LeafSize {
			t.Fatalf("child %d has invalid length %d", index, childVector.Length)
		}
		if !isFinal && childVector.Length != vectors.PresentRoot.LeafSize {
			t.Fatalf("non-final child %d has %d bytes, want %d", index, childVector.Length, vectors.PresentRoot.LeafSize)
		}
		payload := make([]byte, childVector.Length)
		for offset := range payload {
			payload[offset] = childVector.FillByte
		}
		child := goldenDataHash(t, fmt.Sprintf("tree child %d", index), payload, childVector.HashHex)
		treeInput = append(treeInput, child[:]...)
	}
	treeHash := assertGoldenHash(
		t,
		"tree",
		treeInput,
		vectors.Tree.HashInputHex,
		vectors.Tree.HashHex,
	)
	if got := "tree2:" + base64.RawURLEncoding.EncodeToString(treeHash[:]); got != vectors.Tree.ID {
		t.Fatalf("tree id mismatch: got %q, want %q", got, vectors.Tree.ID)
	}
	if got := hex.EncodeToString(treeHash[:]); got != vectors.PresentRoot.RootHashHex {
		t.Fatalf("present root references %q, want golden tree %q", vectors.PresentRoot.RootHashHex, got)
	}

	assertGoldenHash(
		t,
		"present root",
		rootHashInput(t, vectors.PresentRoot),
		vectors.PresentRoot.HashInputHex,
		vectors.PresentRoot.HashHex,
	)
	assertGoldenHash(
		t,
		"sparse root",
		rootHashInput(t, vectors.SparseRoot),
		vectors.SparseRoot.HashInputHex,
		vectors.SparseRoot.HashHex,
	)
	if got := hex.EncodeToString(fileVersionWire(t, vectors)); got != vectors.FileVersion.BorshHex {
		t.Fatalf("file-version Borsh wire mismatch\n got: %s\nwant: %s", got, vectors.FileVersion.BorshHex)
	}
	if got := hex.EncodeToString(fileVersionIndexWire(t, vectors)); got != vectors.FileVersionIndex.BorshHex {
		t.Fatalf("file-version index Borsh wire mismatch\n got: %s\nwant: %s", got, vectors.FileVersionIndex.BorshHex)
	}
}
