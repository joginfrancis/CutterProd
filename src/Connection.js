/**
 * ============================================================================
 *                       NETWORK COMMUNICATIONS (WEBSERIAL)
 * ============================================================================
 * 
 * This module manages the real-time link between the browser (User Interface)
 * and the Raspberry Pi Pico over USB Serial.
 * 
 * ============================================================================
 */

import { log } from './Console.js';
import { updateStatus } from './UI.js';

export class MachineConnection {
    constructor(callbacks) {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.connected = false;
        this.callbacks = callbacks || {};
        this.keepReading = true;
        this.listeners = [];
        this.pktState = { type: null, bytes: [], expectedLen: 3 };
    }

    /**
     * Registers a callback listener to receive raw incoming messages.
     */
    addMessageListener(fn) {
        this.listeners.push(fn);
    }

    /**
     * Unregisters a previously registered message listener.
     */
    removeMessageListener(fn) {
        this.listeners = this.listeners.filter(l => l !== fn);
    }

    /**
     * CONNECT
     * Initiates the connection via Web Serial API.
     */
    async connect() {
        if (this.connected) return;

        if (!('serial' in navigator)) {
            log('Web Serial API not supported in this browser. Please use Chrome/Edge.', 'error');
            return;
        }

        try {
            // Prompt user to select a port
            this.port = await navigator.serial.requestPort();
            
            // Open the port at 115200 baud
            await this.port.open({ baudRate: 115200 });

            this.connected = true;
            updateStatus(true);
            log('Connected to Serial Port', 'success');

            // Setup raw binary reader and writer
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();

            this.keepReading = true;
            this.pktState = { type: null, bytes: [], expectedLen: 3 };
            this.readLoop();

        } catch (e) {
            log(`Connection failed: ${e.message}`, 'error');
        }
    }

    /**
     * DISCONNECT
     */
    async disconnect() {
        this.keepReading = false;
        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (e) {}
            this.reader = null;
        }
        if (this.writer) {
            try {
                await this.writer.close();
            } catch (e) {}
            this.writer = null;
        }
        if (this.port) {
            try {
                await this.port.close();
            } catch (e) {}
            this.port = null;
        }
        this.connected = false;
        updateStatus(false);
        log('Disconnected from Serial Port', 'info');
        if (this.callbacks.onDisconnect) this.callbacks.onDisconnect();
    }

    /**
     * READ LOOP
     * Continuously reads raw bytes from the serial port and routes them.
     */
    async readLoop() {
        let textLineBuffer = '';
        try {
            while (this.port.readable && this.keepReading) {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                // Process the chunk byte-by-byte
                for (let i = 0; i < value.length; i++) {
                    const b = value[i];

                    if (this.pktState.type === null) {
                        if (b === 0xAA || b === 0xBB) {
                            this.pktState.type = b;
                            this.pktState.bytes = [b];
                        } else {
                            // Process as ASCII text
                            const char = String.fromCharCode(b);
                            if (char === '\n' || char === '\r') {
                                if (textLineBuffer.length > 0) {
                                    this.handleMessage(textLineBuffer.trim());
                                    textLineBuffer = '';
                                }
                            } else {
                                textLineBuffer += char;
                            }
                        }
                    } else {
                        // Accumulate packet bytes
                        this.pktState.bytes.push(b);
                        if (this.pktState.bytes.length === this.pktState.expectedLen) {
                            const type = this.pktState.type;
                            const bytes = this.pktState.bytes;
                            // Reset state before callback to avoid re-entry issues
                            this.pktState = { type: null, bytes: [], expectedLen: 3 };

                            if (type === 0xAA) {
                                // ACK: 0xAA, seq_lo, seq_hi
                                const seq = bytes[1] | (bytes[2] << 8);
                                if (this.callbacks.onAck) {
                                    this.callbacks.onAck(seq);
                                }
                            } else if (type === 0xBB) {
                                // NACK: 0xBB, reason, 0x00
                                const reason = bytes[1];
                                if (this.callbacks.onNack) {
                                    this.callbacks.onNack(reason);
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (this.keepReading) {
                log(`Serial Read Error: ${error.message}`, 'error');
            }
        } finally {
            try {
                this.reader.releaseLock();
            } catch (e) {}
        }
    }

    /**
     * HANDLE MESSAGE
     * Parses incoming strings from the Pico.
     * Manages protocol state including standard ACKs and Buffer Full signals.
     */
    handleMessage(msg) {
        if (!msg) return;

        // Notify all registered custom message listeners
        this.listeners.forEach(fn => {
            try {
                fn(msg);
            } catch (e) {
                console.error('Error in message listener:', e);
            }
        });

        if (msg.toLowerCase() === 'ok' || msg.toLowerCase() === 'ack' || msg.toLowerCase() === 'seq reset') {
            log(`PICO: ${msg}`, 'success'); // Standard acknowledgment, ready for next command
            if (this.callbacks.onAckText) this.callbacks.onAckText();
        } else if (msg.toLowerCase() === 'ready') {
            log(`PICO: ${msg}`, 'success'); 
            if (this.callbacks.onReady) this.callbacks.onReady();
        } else if (msg.toLowerCase() === 'nope') {
            log(`PICO: ${msg} (Buffer full, waiting for ready...)`, 'warning');
            if (this.callbacks.onNope) this.callbacks.onNope();
        } else {
            // Otherwise just log it (debug info, coordinates, etc)
            log(`PICO: ${msg}`, 'info');
        }
    }

    /**
     * SEND DATA
     * Sends a string to the Pico over Serial or a raw Uint8Array.
     */
    async send(data, isManual = false) {
        if (!this.connected || !this.writer) {
            log('Error: Not connected', 'error');
            return;
        }
        
        try {
            let buffer;
            if (typeof data === 'string') {
                const encoder = new TextEncoder();
                const text = data.endsWith('\n') ? data : data + '\n';
                buffer = encoder.encode(text);
                if (isManual) log(`> ${data}`, 'tx');
            } else if (data instanceof Uint8Array) {
                buffer = data;
            } else if (data instanceof ArrayBuffer) {
                buffer = new Uint8Array(data);
            } else {
                throw new Error("Unsupported format");
            }
            await this.writer.write(buffer);
        } catch (e) {
            log(`Send error: ${e.message}`, 'error');
        }
    }
}