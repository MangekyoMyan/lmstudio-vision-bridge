// Generates a small, deterministic PNG (two color halves) without any
// external dependency, for the Phase 1/2/3 vision tests. The exact pixel
// pattern is irrelevant — the point is a real, readable image file that the
// generator can encode to a data URL.

import zlib from "node:zlib";
import path from "node:path";
import fs from "node:fs";

function crc32(buf) {
    let c;
    let table = crc32.table;

    if (!table) {
        table = crc32.table = new Int32Array(256);

        for (let n = 0; n < 256; n++) {
            c = n;

            for (let k = 0; k < 8; k++) {
                c = c & 1
                    ? 0xedb88320 ^ (c >>> 1)
                    : c >>> 1;
            }

            table[n] = c;
        }
    }

    c = 0xffffffff;

    for (let i = 0; i < buf.length; i++) {
        c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }

    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);

    const typeBuf = Buffer.from(type, "ascii");

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(
        crc32(Buffer.concat([typeBuf, data]))
    );

    return Buffer.concat([
        len,
        typeBuf,
        data,
        crc,
    ]);
}

/**
 * Build an RGB PNG.
 * `pixels` is a function (x, y) -> [r, g, b].
 */
function makePng(width, height, pixels) {
    const raw = Buffer.alloc((width * 3 + 1) * height);

    let off = 0;

    for (let y = 0; y < height; y++) {
        raw[off++] = 0; // PNG filter: none

        for (let x = 0; x < width; x++) {
            const [r, g, b] = pixels(x, y);

            raw[off++] = r & 0xff;
            raw[off++] = g & 0xff;
            raw[off++] = b & 0xff;
        }
    }

    const ihdr = Buffer.alloc(13);

    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);

    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor

    return Buffer.concat([
        Buffer.from([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
        ]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const DEFAULT_PIXELS = (x, w) =>
    x < w / 2
        ? [220, 30, 30]
        : [30, 60, 220];

/**
 * Build a fixture PNG.
 * `pixels` is (x, width) -> [r, g, b].
 *
 * The default is a red/blue half split:
 * - left side: red
 * - right side: blue
 *
 * Pass a different `pixels` function to get different file content.
 * This is needed by dedup tests, which key on content hash.
 */
export function makeFixtureImage(
    width = 64,
    height = 48,
    pixels = (x) => DEFAULT_PIXELS(x, width)
) {
    return makePng(width, height, pixels);
}

export function writeFixtureImage(file, pixels) {
    fs.mkdirSync(path.dirname(file), {
        recursive: true,
    });

    const buf = pixels
        ? makeFixtureImage(64, 48, pixels)
        : makeFixtureImage();

    fs.writeFileSync(file, buf);

    return {
        file,
        bytes: buf.length,
    };
}