/**
 * Binary utility functions for the MicroSegment protocol.
 */

/**
 * Compute CRC-8 using polynomial 0x8C.
 * Matches the Pico firmware CRC-8 implementation.
 * @param {Uint8Array} data
 * @returns {number}
 */
export function crc8(data) {
    let crc = 0x00;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x01) {
                crc = (crc >> 1) ^ 0x8C;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc & 0xFF;
}

/**
 * Pack a MicroSegment into a 26-byte wire packet.
 * 
 * Packet format:
 *   [0]      magic (0xAB)
 *   [1..4]   dx       int32 LE
 *   [5..8]   dy       int32 LE
 *   [9..12]  dz       int32 LE
 *   [13..16] da       int32 LE
 *   [17..20] interval uint32 LE
 *   [21]     flags    uint8
 *   [22]     seq      uint8
 *   [23..24] pad      2 bytes (0x00)
 *   [25]     CRC8 over bytes [0..24]
 * 
 * @returns {Uint8Array} 26-byte packet buffer
 */
export function packMicrosegment(dx, dy, dz, da, interval, flags = 0, seq = 0) {
    const buffer = new ArrayBuffer(26);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    view.setUint8(0, 0xAB);
    view.setInt32(1, dx, true);
    view.setInt32(5, dy, true);
    view.setInt32(9, dz, true);
    view.setInt32(13, da, true);
    view.setUint32(17, interval, true);
    view.setUint8(21, flags);
    view.setUint8(22, seq & 0xFF);
    view.setUint8(23, 0);
    view.setUint8(24, 0);

    const crc = crc8(uint8.subarray(0, 25));
    view.setUint8(25, crc);

    return uint8;
}
