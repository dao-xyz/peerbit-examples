import type { BinaryReader, BinaryWriter, CustomField } from "@dao-xyz/borsh";

type BoundedUtf8Options = Readonly<{
    name: string;
    maxUtf8Bytes: number;
    prefix?: string;
}>;

type BoundedUtf8ArrayOptions = BoundedUtf8Options &
    Readonly<{
        maxCount: number;
        maxAggregateUtf8Bytes: number;
        unique?: boolean;
    }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
    fatal: true,
    // Preserve a leading U+FEFF so encode/decode equality is exact.
    ignoreBOM: true,
});

export const merkleWireFailV1 = (message: string): never => {
    throw new Error(`Invalid Merkle v1 wire value: ${message}`);
};

const remainingBytes = (reader: BinaryReader) =>
    reader._buf.byteLength - reader._offset;

const requireRemaining = (
    reader: BinaryReader,
    length: number,
    name: string
) => {
    if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > remainingBytes(reader)
    ) {
        return merkleWireFailV1(`${name} exceeds the remaining wire bytes`);
    }
};

const readU32 = (reader: BinaryReader, name: string) => {
    requireRemaining(reader, 4, `${name} length`);
    return reader.u32();
};

const strictUtf8 = (bytes: Uint8Array, name: string) => {
    let value: string;
    try {
        value = decoder.decode(bytes);
    } catch {
        return merkleWireFailV1(`${name} is not canonical UTF-8`);
    }
    const canonical = encoder.encode(value);
    if (
        canonical.byteLength !== bytes.byteLength ||
        canonical.some((byte, index) => byte !== bytes[index])
    ) {
        return merkleWireFailV1(`${name} is not canonical UTF-8`);
    }
    return value;
};

export const boundedUtf8ValueV1 = (
    value: unknown,
    options: BoundedUtf8Options
) => {
    if (typeof value !== "string") {
        return merkleWireFailV1(`${options.name} must be a string`);
    }
    if (value.length === 0) {
        return merkleWireFailV1(`${options.name} must not be empty`);
    }
    if (options.prefix && !value.startsWith(options.prefix)) {
        return merkleWireFailV1(
            `${options.name} must start with ${options.prefix}`
        );
    }
    if (options.prefix && value.length === options.prefix.length) {
        return merkleWireFailV1(
            `${options.name} must include a value after ${options.prefix}`
        );
    }
    const bytes = encoder.encode(value);
    if (strictUtf8(bytes, options.name) !== value) {
        return merkleWireFailV1(
            `${options.name} must contain well-formed Unicode`
        );
    }
    if (bytes.byteLength > options.maxUtf8Bytes) {
        return merkleWireFailV1(
            `${options.name} exceeds ${options.maxUtf8Bytes} UTF-8 bytes`
        );
    }
    return { value, bytes };
};

const readBoundedUtf8 = (
    reader: BinaryReader,
    options: BoundedUtf8Options,
    remainingAggregate = options.maxUtf8Bytes
) => {
    const length = readU32(reader, options.name);
    if (length > options.maxUtf8Bytes) {
        return merkleWireFailV1(
            `${options.name} exceeds ${options.maxUtf8Bytes} UTF-8 bytes`
        );
    }
    if (length > remainingAggregate) {
        return merkleWireFailV1(
            `${options.name} exceeds its aggregate UTF-8 byte bound`
        );
    }
    requireRemaining(reader, length, options.name);
    const bytes = reader.buffer(length);
    const value = strictUtf8(bytes, options.name);
    return boundedUtf8ValueV1(value, options);
};

export const boundedUtf8FieldV1 = (
    options: BoundedUtf8Options
): CustomField<string> => ({
    serialize(value: string, writer: BinaryWriter) {
        const normalized = boundedUtf8ValueV1(value, options);
        writer.u32(normalized.bytes.byteLength);
        writer.set(normalized.bytes);
    },
    deserialize(reader: BinaryReader) {
        return readBoundedUtf8(reader, options).value;
    },
});

const boundedUtf8ArrayV1 = (
    value: unknown,
    options: BoundedUtf8ArrayOptions
) => {
    if (!Array.isArray(value)) {
        return merkleWireFailV1(`${options.name} must be an array`);
    }
    const count = value.length;
    if (count > options.maxCount) {
        return merkleWireFailV1(
            `${options.name} exceeds ${options.maxCount} entries`
        );
    }
    const normalized: Array<{ value: string; bytes: Uint8Array }> = [];
    const seen = options.unique ? new Set<string>() : undefined;
    let aggregate = 0;
    for (let index = 0; index < count; index++) {
        const source = value[index];
        const item = boundedUtf8ValueV1(source, {
            ...options,
            name: `${options.name}[${index}]`,
        });
        aggregate += item.bytes.byteLength;
        if (aggregate > options.maxAggregateUtf8Bytes) {
            return merkleWireFailV1(
                `${options.name} exceeds ${options.maxAggregateUtf8Bytes} aggregate UTF-8 bytes`
            );
        }
        if (seen?.has(item.value)) {
            return merkleWireFailV1(`${options.name} must be unique`);
        }
        seen?.add(item.value);
        normalized.push(item);
    }
    return normalized;
};

export const boundedUtf8ArrayFieldV1 = (
    options: BoundedUtf8ArrayOptions
): CustomField<string[]> => ({
    serialize(value: string[], writer: BinaryWriter) {
        const normalized = boundedUtf8ArrayV1(value, options);
        writer.u32(normalized.length);
        for (const item of normalized) {
            writer.u32(item.bytes.byteLength);
            writer.set(item.bytes);
        }
    },
    deserialize(reader: BinaryReader) {
        const count = readU32(reader, options.name);
        if (count > options.maxCount) {
            return merkleWireFailV1(
                `${options.name} exceeds ${options.maxCount} entries`
            );
        }
        const result = new Array<string>(count);
        const seen = options.unique ? new Set<string>() : undefined;
        let aggregate = 0;
        for (let index = 0; index < count; index++) {
            const item = readBoundedUtf8(
                reader,
                {
                    ...options,
                    name: `${options.name}[${index}]`,
                },
                options.maxAggregateUtf8Bytes - aggregate
            );
            aggregate += item.bytes.byteLength;
            if (seen?.has(item.value)) {
                return merkleWireFailV1(`${options.name} must be unique`);
            }
            seen?.add(item.value);
            result[index] = item.value;
        }
        return result;
    },
});

export const fixedBytesFieldV1 = (
    length: number,
    name: string
): CustomField<Uint8Array> => ({
    serialize(value: Uint8Array, writer: BinaryWriter) {
        if (!(value instanceof Uint8Array) || value.byteLength !== length) {
            return merkleWireFailV1(
                `${name} must contain exactly ${length} bytes`
            );
        }
        writer.set(new Uint8Array(value));
    },
    deserialize(reader: BinaryReader) {
        requireRemaining(reader, length, name);
        return new Uint8Array(reader.buffer(length));
    },
});

export const boundedBytesFieldV1 = (
    minimum: number,
    maximum: number,
    name: string
): CustomField<Uint8Array> => ({
    serialize(value: Uint8Array, writer: BinaryWriter) {
        if (
            !(value instanceof Uint8Array) ||
            value.byteLength < minimum ||
            value.byteLength > maximum
        ) {
            return merkleWireFailV1(
                `${name} length must be from ${minimum} through ${maximum}`
            );
        }
        const snapshot = new Uint8Array(value);
        writer.u32(snapshot.byteLength);
        writer.set(snapshot);
    },
    deserialize(reader: BinaryReader) {
        const length = readU32(reader, name);
        if (length < minimum || length > maximum) {
            return merkleWireFailV1(
                `${name} length must be from ${minimum} through ${maximum}`
            );
        }
        requireRemaining(reader, length, name);
        return new Uint8Array(reader.buffer(length));
    },
});

export const fixedBytesArrayFieldV1 = (
    length: number,
    maximumCount: number,
    name: string
): CustomField<Uint8Array[]> => ({
    serialize(value: Uint8Array[], writer: BinaryWriter) {
        if (!Array.isArray(value)) {
            return merkleWireFailV1(`${name} must be an array`);
        }
        const count = value.length;
        if (count > maximumCount) {
            return merkleWireFailV1(
                `${name} must contain at most ${maximumCount} entries`
            );
        }
        const snapshot = new Array<Uint8Array>(count);
        for (let index = 0; index < count; index++) {
            const item = value[index];
            if (!(item instanceof Uint8Array) || item.byteLength !== length) {
                return merkleWireFailV1(
                    `${name}[${index}] must contain exactly ${length} bytes`
                );
            }
            snapshot[index] = new Uint8Array(item);
        }
        writer.u32(snapshot.length);
        for (const item of snapshot) writer.set(item);
    },
    deserialize(reader: BinaryReader) {
        const count = readU32(reader, name);
        if (count > maximumCount) {
            return merkleWireFailV1(`${name} exceeds ${maximumCount} entries`);
        }
        const totalBytes = count * length;
        requireRemaining(reader, totalBytes, name);
        const result = new Array<Uint8Array>(count);
        for (let index = 0; index < count; index++) {
            result[index] = new Uint8Array(reader.buffer(length));
        }
        return result;
    },
});

export const copyWireAndReadVariantV1 = (
    encoded: unknown,
    maximumWireBytes: number,
    maximumVariantUtf8Bytes: number
) => {
    if (!(encoded instanceof Uint8Array)) {
        return merkleWireFailV1("encoded value must be a Uint8Array");
    }
    if (encoded.byteLength > maximumWireBytes) {
        return merkleWireFailV1(
            `encoded value exceeds ${maximumWireBytes} bytes`
        );
    }
    const wire = new Uint8Array(encoded);
    if (wire.byteLength < 4) {
        return merkleWireFailV1(
            "variant length exceeds the remaining wire bytes"
        );
    }
    const variantLength = new DataView(
        wire.buffer,
        wire.byteOffset,
        wire.byteLength
    ).getUint32(0, true);
    if (variantLength > maximumVariantUtf8Bytes) {
        return merkleWireFailV1(
            `variant exceeds ${maximumVariantUtf8Bytes} UTF-8 bytes`
        );
    }
    if (variantLength > wire.byteLength - 4) {
        return merkleWireFailV1(
            "variant length exceeds the remaining wire bytes"
        );
    }
    const variantBytes = wire.subarray(4, 4 + variantLength);
    const variant = strictUtf8(variantBytes, "variant");
    if (variant.length === 0) {
        return merkleWireFailV1("variant must not be empty");
    }
    return { wire, variant };
};

export const assertExactWireRoundTripV1 = (
    wire: Uint8Array,
    canonical: Uint8Array
) => {
    if (
        wire.byteLength !== canonical.byteLength ||
        wire.some((byte, index) => byte !== canonical[index])
    ) {
        return merkleWireFailV1("encoded value is not canonical Borsh");
    }
};
