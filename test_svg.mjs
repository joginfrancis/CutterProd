import { JSDOM } from 'jsdom';
const dom = new JSDOM();
global.DOMParser = dom.window.DOMParser;

import SvgConverter from './src/SvgConverter.js';
import fs from 'fs';

const sampleSvg = fs.readFileSync('test_multi_shape.svg', 'utf8');

const converter = new SvgConverter({
    feedRate: 50, // mm/s
    segmentLength: 1.0, // 1mm segments
    stepsPerMM_X: 160,
    stepsPerMM_Y: 160,
    stepsPerMM_Z: 1200,
    stepsPerDeg_A: 120,
    zUp: 5,
    zDown: 0,
    acceleration: 1000.0,      // XY acceleration
    accelerationZ: 400.0,      // Z acceleration
    accelerationA: 2000.0,     // A acceleration
    junctionDeviation: 0.05
});

const result = converter.convert(sampleSvg);

console.log("=== TRAJECTORY ANALYSIS FOR MULTI-SHAPE SVG ===");
console.log("Preamble G-code lines generated:", result.preamble.length);
console.log("Total binary packets:", result.packets.length);

// Print segments of G-code moves to show how speed profiles transition
console.log("\n--- [Shape 1: Rectangle (sharp corners)] ---");
const moves = result.preamble.filter(l => l.includes('MOVE'));
let rectMoves = moves.filter(m => m.includes('Z:0.000')); // when pen is down at Z:0.0
console.log("First 15 rect cutting moves:");
console.log(rectMoves.slice(0, 15).join('\n'));

console.log("\n--- [Shape transitions (Pen Lift/Plunge)] ---");
// Let's print around the Z lifts/plunges where pen goes Up (Z:5.0)
const zMoves = moves.filter(m => m.includes('Z:5.000') || m.includes('Z:0.000'));
// Let's look at the transition after the first shape is cut.
// We should see a deceleration to 0.0, then Z-up, then travel, then Z-down, then acceleration to feedrate.
console.log("Transition moves around shape changes:");
console.log(moves.filter(m => {
    return m.includes('Z:5.000') || m.includes('vEntry:0.0') || m.includes('vExit:0.0');
}).slice(0, 20).join('\n'));

console.log("\n--- [Shape 2: Circle (smooth curves)] ---");
// Let's find moves where X and Y are in the circle area (e.g., around X:120, Y:50)
const circleMoves = moves.filter(m => {
    // Check if within circle bounding box: X in [90, 150], Y in [20, 80] and Z is down
    const match = m.match(/X:([0-9.-]+) Y:([0-9.-]+) Z:([0-9.-]+)/);
    if (!match) return false;
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z = parseFloat(match[3]);
    return x >= 90 && x <= 150 && y >= 20 && y <= 80 && z === 0;
});
console.log("Sample circle cutting moves:");
console.log(circleMoves.slice(0, 10).join('\n'));
