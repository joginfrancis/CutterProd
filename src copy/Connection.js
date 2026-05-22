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
    }

    /**
     * CONNECT
     * Initiates the connection via Web Serial API.
     */
    async connect() {
        if (this.connected) return;

        if (!('serial' in navigator)) {
            let errorMsg = 'Web Serial API not supported in this browser.';
            
            if (window.location.protocol === 'file:') {
                errorMsg += ' (Web Serial requires a web server; it cannot run from a local file. Use "python3 -m http.server" on your Pi)';
            } else if (window.location.hostname !== 'localhost' && window.location.protocol !== 'https:') {
                errorMsg += ' (Web Serial requires HTTPS or localhost for security)';
            } else {
                errorMsg += ' Please use Chromium or Edge and check chrome://flags/#enable-experimental-web-platform-features';
            }
            
            log(errorMsg, 'error');
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

            // Setup the text encoder/decoder streams
            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            const textEncoder = new TextEncoderStream();
            this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            this.keepReading = true;
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
            await this.reader.cancel();
        }
        if (this.writer) {
            await this.writer.close();
        }
        if (this.port) {
            await this.port.close();
        }
        this.connected = false;
        updateStatus(false);
        log('Disconnected from Serial Port', 'info');
        if (this.callbacks.onDisconnect) this.callbacks.onDisconnect();
    }

    /**
     * READ LOOP
     * Continuously reads data from the serial port.
     */
    async readLoop() {
        let buffer = '';
        try {
            while (this.port.readable && this.keepReading) {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                buffer += value;
                let lines = buffer.split('\n');
                // The last element is either empty string or an incomplete line
                buffer = lines.pop(); 

                for (let line of lines) {
                    this.handleMessage(line.trim());
                }
            }
        } catch (error) {
            log(`Serial Read Error: ${error.message}`, 'error');
        } finally {
            this.reader.releaseLock();
        }
    }

    /**
     * HANDLE MESSAGE
     * Parses incoming strings from the Pico.
     * Manages protocol state including standard ACKs and Buffer Full signals.
     */
    handleMessage(msg) {
        if (!msg) return;

        if (msg.toLowerCase() === 'ok' || msg.toLowerCase() === 'ack') {
            log(`PICO: ${msg}`, 'success'); // Standard acknowledgment, ready for next command
            if (this.callbacks.onAck) this.callbacks.onAck();
        } else if (msg.toLowerCase() === 'ready') {
            log(`PICO: ${msg}`, 'success'); 
            // The pico sends 'ready' when its hardware buffer has cleared after previously
            // throwing a 'nope'. This triggers the UI to resume feeding the job.
            if (this.callbacks.onReady) this.callbacks.onReady();
        } else if (msg.toLowerCase() === 'nope') {
            log(`PICO: ${msg} (Buffer full, waiting for ready...)`, 'warning');
            // Buffer is full. The UI should pause sending and wait for the 'ready' signal.
            if (this.callbacks.onNope) this.callbacks.onNope();
        } else {
            // Otherwise just log it (debug info, coordinates, etc)
            log(`PICO: ${msg}`, 'info');
        }
    }

    /**
     * SEND COMMAND
     * Sends a string to the Pico over Serial.
     */
    async send(cmd, isManual = false) {
        if (!this.connected || !this.writer) {
            log('Error: Not connected', 'error');
            return;
        }
        
        try {
            // Send the command with a newline
            await this.writer.write(cmd + '\n');
            if (isManual) log(`> ${cmd}`, 'tx');
        } catch (e) {
            log(`Send error: ${e.message}`, 'error');
        }
    }
}