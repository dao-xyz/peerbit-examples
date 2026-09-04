package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"unicode/utf8"
)

const (
	ipcProtocolName                   = "peerbit-shared-fs-ipc"
	ipcNegotiateOperation             = "$peerbit.shared-fs.ipc.negotiate"
	ipcNegotiationMaxBytes            = 64 * 1024
	defaultIPCMaxMetadataBytes        = 1024 * 1024
	ipcV2HeaderBytes                  = 16
	ipcV2RequestKind           uint8  = 1
	ipcV2ResponseKind          uint8  = 2
	maxIPCJSONSafeInteger      uint64 = 1<<53 - 1
)

var ipcV2Magic = [4]byte{'P', 'B', 'F', 'S'}

type ipcWireProtocol uint8

const (
	ipcWireProtocolUnset ipcWireProtocol = iota
	ipcWireProtocolV1
	ipcWireProtocolV2
)

type ipcV2Limits struct {
	maxRequestFrameBytes  int
	maxResponseFrameBytes int
	maxMetadataBytes      int
}

type ipcV2EncodedFrame struct {
	header   [ipcV2HeaderBytes]byte
	metadata []byte
	body     []byte
}

type ipcV2Frame struct {
	metadata []byte
	body     []byte
}

type ipcNegotiationOffer struct {
	Protocol              string `json:"protocol"`
	Versions              []int  `json:"versions"`
	Nonce                 string `json:"nonce"`
	MaxRequestFrameBytes  int    `json:"maxRequestFrameBytes"`
	MaxResponseFrameBytes int    `json:"maxResponseFrameBytes"`
}

type ipcNegotiationRequest struct {
	ID   uint64                `json:"id"`
	Op   string                `json:"op"`
	Args []ipcNegotiationOffer `json:"args"`
}

func newIPCNonce() (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(nonce[:]), nil
}

func encodeIPCV2Frame(kind uint8, metadataValue interface{}, body []byte, maxFrameBytes, maxMetadataBytes int) (ipcV2EncodedFrame, error) {
	var frame ipcV2EncodedFrame
	if maxFrameBytes <= 0 || maxMetadataBytes <= 0 || maxMetadataBytes > maxFrameBytes {
		return frame, errors.New("IPC v2 limits are invalid")
	}
	if kind != ipcV2RequestKind && kind != ipcV2ResponseKind {
		return frame, errors.New("invalid IPC v2 frame kind")
	}
	metadata, err := json.Marshal(metadataValue)
	if err != nil {
		return frame, err
	}
	if len(metadata) > maxMetadataBytes {
		return frame, fmt.Errorf("%w: metadata is %d bytes, limit is %d", errIPCFrameTooLarge, len(metadata), maxMetadataBytes)
	}
	if len(metadata) > maxFrameBytes || len(body) > maxFrameBytes-len(metadata) {
		return frame, fmt.Errorf("%w: frame is %d bytes, limit is %d", errIPCFrameTooLarge, len(metadata)+len(body), maxFrameBytes)
	}
	if uint64(len(metadata)) > uint64(^uint32(0)) || uint64(len(body)) > uint64(^uint32(0)) {
		return frame, fmt.Errorf("%w: v2 section length exceeds uint32", errIPCFrameTooLarge)
	}
	copy(frame.header[0:4], ipcV2Magic[:])
	frame.header[4] = 2
	frame.header[5] = kind
	binary.BigEndian.PutUint16(frame.header[6:8], 0)
	binary.BigEndian.PutUint32(frame.header[8:12], uint32(len(metadata)))
	binary.BigEndian.PutUint32(frame.header[12:16], uint32(len(body)))
	frame.metadata = metadata
	frame.body = body
	return frame, nil
}

func writeIPCV2Frame(conn net.Conn, frame ipcV2EncodedFrame) error {
	parts := net.Buffers{frame.header[:], frame.metadata}
	if len(frame.body) > 0 {
		parts = append(parts, frame.body)
	}
	_, err := parts.WriteTo(conn)
	return err
}

func readIPCV2Frame(reader *bufio.Reader, expectedKind uint8, maxFrameBytes, maxMetadataBytes int) (ipcV2Frame, error) {
	var frame ipcV2Frame
	if maxFrameBytes <= 0 || maxMetadataBytes <= 0 || maxMetadataBytes > maxFrameBytes {
		return frame, errors.New("IPC v2 limits are invalid")
	}
	var header [ipcV2HeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return frame, err
	}
	if !bytes.Equal(header[0:4], ipcV2Magic[:]) {
		return frame, errors.New("invalid IPC v2 magic")
	}
	if header[4] != 2 {
		return frame, fmt.Errorf("invalid IPC v2 version %d", header[4])
	}
	if header[5] != expectedKind {
		return frame, fmt.Errorf("invalid IPC v2 frame kind %d", header[5])
	}
	if binary.BigEndian.Uint16(header[6:8]) != 0 {
		return frame, errors.New("unsupported IPC v2 flags")
	}
	metadataBytes := uint64(binary.BigEndian.Uint32(header[8:12]))
	bodyBytes := uint64(binary.BigEndian.Uint32(header[12:16]))
	if metadataBytes > uint64(maxMetadataBytes) {
		return frame, fmt.Errorf("%w: metadata is %d bytes, limit is %d", errIPCFrameTooLarge, metadataBytes, maxMetadataBytes)
	}
	frameLimit := uint64(maxFrameBytes)
	if metadataBytes > frameLimit || bodyBytes > frameLimit-metadataBytes {
		return frame, fmt.Errorf("%w: frame is %d bytes, limit is %d", errIPCFrameTooLarge, metadataBytes+bodyBytes, maxFrameBytes)
	}
	frame.metadata = make([]byte, int(metadataBytes))
	if _, err := io.ReadFull(reader, frame.metadata); err != nil {
		return ipcV2Frame{}, err
	}
	frame.body = make([]byte, int(bodyBytes))
	if _, err := io.ReadFull(reader, frame.body); err != nil {
		return ipcV2Frame{}, err
	}
	if !utf8.Valid(frame.metadata) {
		return ipcV2Frame{}, errors.New("IPC v2 metadata is not valid UTF-8")
	}
	return frame, nil
}

func rawObject(raw json.RawMessage, context string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, fmt.Errorf("%s must be an object", context)
	}
	return object, nil
}

func parseSafeUint(raw json.RawMessage, context string) (uint64, error) {
	integer, err := strconv.ParseUint(string(raw), 10, 64)
	if err != nil || integer > maxIPCJSONSafeInteger {
		return 0, fmt.Errorf("%s must be a non-negative safe integer", context)
	}
	return integer, nil
}

func parsePositiveUint32(raw json.RawMessage, context string) (int, error) {
	value, err := parseSafeUint(raw, context)
	if err != nil || value == 0 || value > uint64(^uint32(0)) {
		return 0, fmt.Errorf("%s must be an integer from 1 through 4294967295", context)
	}
	if value > uint64(^uint(0)>>1) {
		return 0, fmt.Errorf("%s exceeds this platform's allocation range", context)
	}
	return int(value), nil
}

func parseRequiredBool(raw json.RawMessage, context string) (bool, error) {
	if bytes.Equal(raw, []byte("true")) {
		return true, nil
	}
	if bytes.Equal(raw, []byte("false")) {
		return false, nil
	}
	return false, fmt.Errorf("%s must be a boolean", context)
}

func parseRequiredString(raw json.RawMessage, context string) (string, error) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s must be a string", context)
	}
	return value, nil
}

func parseIPCError(raw json.RawMessage) (*ipcError, error) {
	object, err := rawObject(raw, "IPC error")
	if err != nil {
		return nil, err
	}
	message, err := parseRequiredString(object["message"], "IPC error message")
	if err != nil {
		return nil, err
	}
	code := ""
	if rawCode, exists := object["code"]; exists {
		code, err = parseRequiredString(rawCode, "IPC error code")
		if err != nil {
			return nil, err
		}
	}
	return &ipcError{Code: code, Message: message}, nil
}

func containsIPCBytesMember(value interface{}) bool {
	switch typed := value.(type) {
	case map[string]interface{}:
		if _, exists := typed["$bytes"]; exists {
			return true
		}
		for _, entry := range typed {
			if containsIPCBytesMember(entry) {
				return true
			}
		}
	case []interface{}:
		for _, entry := range typed {
			if containsIPCBytesMember(entry) {
				return true
			}
		}
	}
	return false
}

func objectHasUnexpectedIPCBytes(object map[string]json.RawMessage, skipped ...string) (bool, error) {
	for key, raw := range object {
		ignored := false
		for _, skippedKey := range skipped {
			if key == skippedKey {
				ignored = true
				break
			}
		}
		if ignored {
			continue
		}
		var value interface{}
		if err := json.Unmarshal(raw, &value); err != nil {
			return false, err
		}
		if containsIPCBytesMember(value) {
			return true, nil
		}
	}
	return false, nil
}

func parseIPCV2Response(frame ipcV2Frame, requestID uint64, operation string) (interface{}, error) {
	object, err := rawObject(frame.metadata, "IPC v2 response")
	if err != nil {
		return nil, err
	}
	id, err := parseSafeUint(object["id"], "IPC response id")
	if err != nil || id != requestID {
		return nil, fmt.Errorf("unexpected response id %d for request %d", id, requestID)
	}
	ok, err := parseRequiredBool(object["ok"], "IPC response ok")
	if err != nil {
		return nil, err
	}
	if !ok {
		if len(frame.body) != 0 {
			return nil, errors.New("IPC v2 error response has an unexpected body")
		}
		parsedError, err := parseIPCError(object["error"])
		if err != nil {
			return nil, err
		}
		unexpectedBytes, scanErr := objectHasUnexpectedIPCBytes(object, "id", "ok")
		if scanErr != nil || unexpectedBytes {
			return nil, errors.New("IPC v2 error response has an unexpected bytes sentinel")
		}
		return nil, parsedError
	}
	resultRaw, exists := object["result"]
	if !exists {
		return nil, errors.New("IPC v2 success response is missing result")
	}
	if operation == "read" {
		sentinel, err := rawObject(resultRaw, "IPC v2 read result")
		rawBytes, hasBytes := sentinel["$bytes"]
		var sentinelValue interface{}
		if err != nil || len(sentinel) != 1 || !hasBytes || json.Unmarshal(rawBytes, &sentinelValue) != nil || sentinelValue != nil {
			return nil, errors.New("IPC v2 read response requires the raw-bytes sentinel")
		}
		unexpectedBytes, scanErr := objectHasUnexpectedIPCBytes(object, "id", "ok", "result")
		if scanErr != nil || unexpectedBytes {
			return nil, errors.New("IPC v2 read response has an unexpected bytes sentinel")
		}
		return frame.body, nil
	}
	if len(frame.body) != 0 {
		return nil, errors.New("IPC v2 response has an unexpected body")
	}
	var result interface{}
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		return nil, err
	}
	if containsIPCBytesMember(result) {
		return nil, errors.New("IPC v2 response has an unexpected bytes sentinel")
	}
	unexpectedBytes, scanErr := objectHasUnexpectedIPCBytes(object, "id", "ok", "result")
	if scanErr != nil || unexpectedBytes {
		return nil, errors.New("IPC v2 response has an unexpected bytes sentinel")
	}
	return result, nil
}

func encodeIPCV2Request(request ipcRequest, args []interface{}, maxFrameBytes, maxMetadataBytes int) (ipcV2EncodedFrame, error) {
	request.Args = args
	body := []byte(nil)
	if request.Op == "write" {
		if len(args) != 3 {
			return ipcV2EncodedFrame{}, errors.New("IPC v2 write requires three arguments")
		}
		bytesArgument, ok := args[1].([]byte)
		if !ok {
			return ipcV2EncodedFrame{}, errors.New("IPC v2 write requires a byte argument")
		}
		request.Args = append([]interface{}(nil), args...)
		request.Args[1] = map[string]interface{}{"$bytes": nil}
		body = bytesArgument
	} else if containsNativeBytes(args) {
		return ipcV2EncodedFrame{}, errors.New("IPC v2 bytes are only valid for write")
	}
	return encodeIPCV2Frame(ipcV2RequestKind, request, body, maxFrameBytes, maxMetadataBytes)
}

func containsNativeBytes(value interface{}) bool {
	switch typed := value.(type) {
	case []byte:
		return true
	case []interface{}:
		for _, entry := range typed {
			if containsNativeBytes(entry) {
				return true
			}
		}
	case map[string]interface{}:
		for _, entry := range typed {
			if containsNativeBytes(entry) {
				return true
			}
		}
	}
	return false
}

func negotiateIPCV2(conn net.Conn, reader *bufio.Reader, offerLimits ipcV2Limits) (ipcWireProtocol, ipcV2Limits, bool, error) {
	nonce, err := newIPCNonce()
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	const negotiationID uint64 = 0
	offer := ipcNegotiationRequest{
		ID: negotiationID,
		Op: ipcNegotiateOperation,
		Args: []ipcNegotiationOffer{{
			Protocol: ipcProtocolName, Versions: []int{2, 1}, Nonce: nonce,
			MaxRequestFrameBytes: offerLimits.maxRequestFrameBytes, MaxResponseFrameBytes: offerLimits.maxResponseFrameBytes,
		}},
	}
	encoded, err := json.Marshal(offer)
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	if len(encoded) > ipcNegotiationMaxBytes {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation offer exceeds byte limit")
	}
	// Very small configured v1 request bounds may not fit the additive
	// negotiation request. In that case the untouched connection can safely
	// begin with the caller's ordinary v1 filesystem operation.
	if len(encoded) > offerLimits.maxRequestFrameBytes {
		return ipcWireProtocolV1, ipcV2Limits{}, false, nil
	}
	encoded = append(encoded, '\n')
	frames := net.Buffers{encoded}
	if _, err := frames.WriteTo(conn); err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, true, err
	}
	line, err := readBoundedJSONLine(reader, ipcNegotiationMaxBytes)
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, !errors.Is(err, errIPCFrameTooLarge), err
	}
	if reader.Buffered() != 0 {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC server sent bytes before negotiation completed")
	}
	envelope, err := rawObject(line, "IPC negotiation response")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	id, err := parseSafeUint(envelope["id"], "IPC negotiation response id")
	if err != nil || id != negotiationID {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation response id mismatch")
	}
	ok, err := parseRequiredBool(envelope["ok"], "IPC negotiation response ok")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	if !ok {
		if _, err := parseIPCError(envelope["error"]); err != nil {
			return ipcWireProtocolUnset, ipcV2Limits{}, false, err
		}
		return ipcWireProtocolUnset, ipcV2Limits{}, true, errors.New("IPC v2 negotiation rejected")
	}
	result, err := rawObject(envelope["result"], "IPC negotiation result")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	protocol, err := parseRequiredString(result["protocol"], "IPC negotiation protocol")
	if err != nil || protocol != ipcProtocolName {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation protocol mismatch")
	}
	ackNonce, err := parseRequiredString(result["nonce"], "IPC negotiation nonce")
	if err != nil || ackNonce != nonce {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation nonce mismatch")
	}
	versionValue, err := parseSafeUint(result["version"], "IPC negotiation version")
	if err != nil || (versionValue != 1 && versionValue != 2) {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation selected an unoffered version")
	}
	if versionValue == 1 {
		if _, exists := result["maxRequestFrameBytes"]; exists {
			return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC v1 acknowledgement included v2 limits")
		}
		if _, exists := result["maxResponseFrameBytes"]; exists {
			return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC v1 acknowledgement included v2 limits")
		}
		if _, exists := result["maxMetadataBytes"]; exists {
			return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC v1 acknowledgement included v2 limits")
		}
		return ipcWireProtocolV1, ipcV2Limits{}, false, nil
	}
	requestLimit, err := parsePositiveUint32(result["maxRequestFrameBytes"], "IPC negotiated request limit")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	responseLimit, err := parsePositiveUint32(result["maxResponseFrameBytes"], "IPC negotiated response limit")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	metadataLimit, err := parsePositiveUint32(result["maxMetadataBytes"], "IPC negotiated metadata limit")
	if err != nil {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, err
	}
	if requestLimit > offerLimits.maxRequestFrameBytes || responseLimit > offerLimits.maxResponseFrameBytes || metadataLimit > defaultIPCMaxMetadataBytes || metadataLimit > requestLimit || metadataLimit > responseLimit {
		return ipcWireProtocolUnset, ipcV2Limits{}, false, errors.New("IPC negotiation returned invalid limits")
	}
	return ipcWireProtocolV2, ipcV2Limits{
		maxRequestFrameBytes: requestLimit, maxResponseFrameBytes: responseLimit, maxMetadataBytes: metadataLimit,
	}, false, nil
}
