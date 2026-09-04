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
	"testing"
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

type merkleGoldenVectors struct {
	Format          string            `json:"format"`
	IntegerEncoding string            `json:"integerEncoding"`
	BitmapBitOrder  string            `json:"bitmapBitOrder"`
	IDEncoding      string            `json:"idEncoding"`
	Data            merkleGoldenBlock `json:"data"`
	Tree            merkleGoldenBlock `json:"tree"`
	PresentRoot     merkleGoldenRoot  `json:"presentRoot"`
	SparseRoot      merkleGoldenRoot  `json:"sparseRoot"`
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
}
