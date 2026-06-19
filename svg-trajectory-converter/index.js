/**
 * ============================================================================
 *                         SVG TO TRAJECTORY CONVERTER
 * ============================================================================
 * 
 * This module is a custom-built geometry engine designed to translate complex
 * vector mathematics into segmented trajectories for real-time machine control.
 * 
 * 1. THE GEOMETRY ENGINE (Vector2 & CubicBezier)
 *    SVG drawings aren't just lists of points; they are mathematical formulas.
 *    - Vector2: Handles the heavy lifting of 2D math (addition, subtraction, 
 *      normalization, and distance checking).
 *    - CubicBezier: Implements the Bernstein Polynomial formula. This formula 
 *      allows us to calculate the exact coordinate (x,y) along a curve at any 
 *      parameter 't' (where t=0 is the start and t=1 is the end).
 * 
 * 2. SHAPE NORMALIZATION (The "Standardizer")
 *    SVG is messy — it has circles, rects, and paths. We convert EVERYTHING into
 *    a "Unified Path" format.
 *    - Circles are converted into 4 Cubic Bezier curves using a magic constant
 *      (0.552284), which approximates a circular arc with 99.9% accuracy.
 *    - Rectangles are converted into a sequence of 4 Linear commands.
 * 
 * 3. THE PATH TOKENIZER (Parsing)
 *    SVG path strings (the 'd' attribute) look like "M10,20 L30,40". 
 *    Our parser:
 *    - Tokenizes: Splits numbers from letters.
 *    - State Tracking: Remembers the "Last Command" to support SVG's shorthand.
 *    - Relative vs Absolute: Converts lower-case commands (relative) into 
 *      global coordinates by adding them to the current pen position.
 * 
 * 4. CURVE FLATTENING & EQUAL-LENGTH SEGMENTATION
 *    Instead of generic G1 moves, we require precise, equidistant trajectory points.
 *    - Straight lines: Subdivided mathematically into chunks matching `segmentLength`.
 *    - Curves: We build a Look-Up Table (LUT) mapping parameter 't' to actual 
 *      physical distance (Arc-Length Parameterization). We use this LUT to 
 *      guarantee that every emitted point along a curve is exactly `segmentLength` 
 *      millimeters apart, rather than equal-time 't' apart.
 *    
 * 5. KINEMATICS & VELOCITY CALCULATIONS
 *    For advanced control (e.g., Look-Up Table kinematics), the machine needs 
 *    to know its intended velocity vector at every point.
 *    - We evaluate the first derivative of the Bezier function: B'(t).
 *    - This calculates the exact instantaneous velocity components (Vx, Vy) at 
 *      any point on the curve, ensuring smooth motion planning.
 * 
 * 6. COORDINATE TRANSFORMATION PIPELINE
 *    Before a number becomes data, it goes through a 4-stage filter:
 *    1. Scale: Convert SVG units to real-world millimeters.
 *    2. Flip Y: Vertical inversion (Screen Y-down vs Machine Y-up).
 *    3. Offset: Shifting the drawing to the center of the physical bed.
 *    4. Rounding: Truncating to 4 decimal places for precision without bloat.
 * 
 * 7. TANGENTIAL KNIFE SUPPORT
 *    The trajectory automatically computes a physical target heading (Angle) 
 *    using `atan2(dy, dx) * 180 / PI`. 
 *    - Shortest Path & Sharp Corners: A shortest rotational difference test is 
 *      performed. If the heading change exceeds the `angleThreshold`, the 
 *      system automatically executes a sequence to lift the tool (Z-Up), 
 *      orient to the new angle, and plunge (Z-Down) to prevent material tearing.
 * ============================================================================
 */

/**
 * @file index.js (svg-trajectory-converter)
 * @description Main entry point and classes for parsing SVG and generating CNC trajectories.
 */

// MicroSegment wire packing + CRC-8 live in a single module (BinaryUtils.js) so
// the two former copies can no longer drift. (Assessment R4 / fix F7.)
import { packMicrosegment } from './BinaryUtils.js';

/**
 * @class Vector2
 * @description Represents a 2D vector with basic arithmetic operations.
 */
class Vector2 {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  add(v) { return new Vector2(this.x + v.x, this.y + v.y); }
  sub(v) { return new Vector2(this.x - v.x, this.y - v.y); }
  mul(s) { return new Vector2(this.x * s, this.y * s); }
  div(s) { return new Vector2(this.x / s, this.y / s); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  lengthSq() { return this.x * this.x + this.y * this.y; }
  normalize() {
    const l = this.length();
    return l === 0 ? new Vector2(0, 0) : this.div(l);
  }
  dist(v) { return this.sub(v).length(); }
}

/**
 * @class CubicBezier
 * @description Represents a Cubic Bezier curve defined by 4 control points.
 */
class CubicBezier {
  /**
   * @constructor
   * @param {Vector2} p0 - Start point.
   * @param {Vector2} p1 - First control point.
   * @param {Vector2} p2 - Second control point.
   * @param {Vector2} p3 - End point.
   */
  constructor(p0, p1, p2, p3) {
    this.p0 = p0;
    this.p1 = p1;
    this.p2 = p2;
    this.p3 = p3;
  }

  /**
   * @method sample
   * @description Calculates a point on the curve at parameter t using Bernstein polynomials.
   * @param {number} t - Interpolation factor (0.0 to 1.0).
   * @returns {Vector2} The point on the curve.
   */
  sample(t) {
    const t1 = 1 - t;
    const a = t1 * t1 * t1;
    const b = 3 * t1 * t1 * t;
    const c = 3 * t1 * t * t;
    const d = t * t * t;
    return new Vector2(
      a * this.p0.x + b * this.p1.x + c * this.p2.x + d * this.p3.x,
      a * this.p0.y + b * this.p1.y + c * this.p2.y + d * this.p3.y
    );
  }

  /**
   * @method getVelocity
   * @description Calculates the instantaneous velocity vector (First Derivative) 
   * of the curve at parameter t.
   * 
   * The formula for the derivative of a Cubic Bezier curve B(t) is:
   * B'(t) = 3(1-t)^2*(P1-P0) + 6(1-t)*t*(P2-P1) + 3t^2*(P3-P2)
   * 
   * This provides the physical direction and speed vector required for the
   * machine's trajectory planner to maintain smooth, continuous motion.
   * 
   * @param {number} t - Interpolation factor (0.0 to 1.0).
   * @returns {Vector2} The velocity vector components (Vx, Vy).
   */
  getVelocity(t) {
      const vel = (p0, p1, p2, p3, t) => {
          const u = 1 - t;
          return 3 * (u ** 2) * (p1 - p0) + 
                 6 * u * t * (p2 - p1) + 
                 3 * (t ** 2) * (p3 - p2);
      };
      return new Vector2(
          vel(this.p0.x, this.p1.x, this.p2.x, this.p3.x, t),
          vel(this.p0.y, this.p1.y, this.p2.y, this.p3.y, t)
      );
  }

  /**
   * @method getLUT
   * @description Generates a Look-Up Table (LUT) of arc lengths.
   * @param {number} steps - Number of samples (e.g., 100).
   * @returns {Array} Array of { t, dist } objects.
   */
  getLUT(steps = 100) {
      const lut = [{ t: 0, dist: 0 }];
      let cur = this.p0;
      let totalDist = 0;
      for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const next = this.sample(t);
          totalDist += cur.dist(next);
          lut.push({ t: t, dist: totalDist });
          cur = next;
      }
      return lut;
  }
}

/**
 * @class SvgConverter
 * @description Main class for parsing SVG strings and generating trajectory data.
 */
class SvgConverter {
  /**
   * @constructor
   * @param {Object} options - Configuration options.
   * @param {number} [options.feedRate=300] - Movement speed.
   * @param {number} [options.scale=1.0] - Global scaling factor.
   * @param {number} [options.offsetX=0] - X offset for centering.
   * @param {number} [options.offsetY=0] - Y offset for centering.
   * @param {number} [options.segmentLength=1.0] - Desired length of linear segments (mm).
   * @param {number} [options.stepsPerMM=1.0] - Scaling factor to convert mm to motor steps.
   */
  constructor(options = {}) {
    this.feedRate = options.feedRate || 300; 
   this.scale = options.scale || 1.0;
   this.offsetX = options.offsetX || 0;
   this.offsetY = options.offsetY || 0;
    this.flipX = options.flipX || false;
   this.flipY = options.flipY || false;
    this.segmentLength = options.segmentLength || 1.0;
    // Per-axis step rates; stepsPerMM is kept as a fallback for backward compat
    const globalSteps = options.stepsPerMM || 1.0;
    this.stepsPerMM_X = options.stepsPerMM_X || globalSteps;
    this.stepsPerMM_Y = options.stepsPerMM_Y || globalSteps;
    // Defaults mirror the firmware machine config (Urumi-Fw config.py):
    // Z = 1200 steps/mm, A = 120 steps/deg. (Assessment R3 / fix F3.)
    this.stepsPerMM_Z = options.stepsPerMM_Z || 1200.0;
    this.stepsPerDeg_A = options.stepsPerDeg_A || 120.0;
    
    this.idX = options.idX !== undefined ? options.idX : 3;
    this.idY = options.idY !== undefined ? options.idY : 2;
    this.idZ = options.idZ !== undefined ? options.idZ : 1;
    this.idA = options.idA !== undefined ? options.idA : 4;
    
    // Z-Axis Config (mm initially, then scaled to steps)
    this.zUp = options.zUp !== undefined ? options.zUp : 5;
    this.zDown = options.zDown !== undefined ? options.zDown : 0;
    
    // Tangential Knife Config
    this.angleThreshold = options.angleThreshold !== undefined ? options.angleThreshold : 10;
    this.homeAngleA = options.homeAngleA !== undefined ? options.homeAngleA : 90;
    this.decimals = 4;

    // Profiling Config
    const defaultAccel = options.acceleration !== undefined ? options.acceleration : 1000.0;
    this.accelerationX = options.accelerationX !== undefined ? options.accelerationX : defaultAccel;
    this.accelerationY = options.accelerationY !== undefined ? options.accelerationY : defaultAccel;
    this.acceleration = Math.min(this.accelerationX, this.accelerationY);
    this.accelerationZ = options.accelerationZ !== undefined ? options.accelerationZ : 500.0;
    this.accelerationA = options.accelerationA !== undefined ? options.accelerationA : 3000.0;
    this.junctionDeviation = options.junctionDeviation !== undefined ? options.junctionDeviation : 0.05;
    
    // Limits
    const defaultSpeed = options.maxXYSpeed !== undefined ? options.maxXYSpeed : (options.maxLinearSpeed !== undefined ? options.maxLinearSpeed : 200);
    this.maxXSpeed = options.maxXSpeed !== undefined ? options.maxXSpeed : defaultSpeed;
    this.maxYSpeed = options.maxYSpeed !== undefined ? options.maxYSpeed : defaultSpeed;
    this.maxZSpeed = options.maxZSpeed !== undefined ? options.maxZSpeed : 10;
    this.maxRotationalSpeed = options.maxRotationalSpeed !== undefined ? options.maxRotationalSpeed : 720;
    
    // F5: Hard-cap speeds based on physical RS485 bandwidth limit (~80 kHz max step rate)
    const maxPhysicalStepRate = 75000;
    
    this.maxXSpeed = Math.min(this.maxXSpeed, maxPhysicalStepRate / this.stepsPerMM_X);
    this.maxYSpeed = Math.min(this.maxYSpeed, maxPhysicalStepRate / this.stepsPerMM_Y);
    this.maxZSpeed = Math.min(this.maxZSpeed, maxPhysicalStepRate / this.stepsPerMM_Z);
    this.maxRotationalSpeed = Math.min(this.maxRotationalSpeed, maxPhysicalStepRate / this.stepsPerDeg_A);
    
    // Combined limit for XY path planning
    this.maxXYSpeed = Math.min(this.maxXSpeed, this.maxYSpeed);
    
    // Automate Max Steps (Per Command) to guarantee a response window of ~0.4s:
    const maxXStepRate = this.maxXSpeed * this.stepsPerMM_X;
    const maxYStepRate = this.maxYSpeed * this.stepsPerMM_Y;
    const maxZStepRate = this.maxZSpeed * this.stepsPerMM_Z;
    const maxLinearStepRateTotal = Math.max(maxXStepRate, maxYStepRate, maxZStepRate);
    
    const targetResponseTime = 0.4; // seconds
    this.maxSteps = Math.round(maxLinearStepRateTotal * targetResponseTime);
    this.maxSteps = Math.max(1000, Math.min(this.maxSteps, 100000));
    
    // Bounds
    this.bedW = options.bedW !== undefined ? options.bedW : Infinity;
    this.bedH = options.bedH !== undefined ? options.bedH : Infinity;
  }

  /**
   * @method transform
   * @description Applies scaling, flipping, and offsets to a point.
   * @param {Vector2} p - The point to transform.
   * @returns {Object} The transformed coordinates {x, y}.
   */
  transform(p) {
      let x = (p.x * this.scale);
      if (this.flipX) {
          x = -x;
      }
      x += this.offsetX;
      let y = (p.y * this.scale);
      if (this.flipY) {
          y = -y;
      }
      y += this.offsetY;
      return { x, y };
  }

  /**
   * @method convert
   * @description Converts an SVG string into a CSV-formatted trajectory string.
   * @param {string} svgContent - The raw XML string of the SVG file.
   * @returns {string} The generated Trajectory Data (CSV format).
   */
  convert(svgContent) {
    this.rawSegments = [];
    
    // First command to enable the motors.
    // WAIT_MS:500 lets the Pico finish its multi-step ENABLE ALL sequence
    // before we send suction or binary commands (prevents "Command queue full").
    this.rawSegments.push({ type: 'meta', command: 'enable all 1' });
    this.rawSegments.push({ type: 'meta', command: 'WAIT_MS:500' });

    const state = {
        isPenDown: false,
        machineX: 0,
        machineY: 0,
        machineZ: this.zUp,
        machineA: this.homeAngleA
    };

    if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgContent, "image/svg+xml");
        
        const svgRoot = doc.querySelector('svg');
        let pageW = 0, pageH = 0;
        if (svgRoot) {
            const vb = svgRoot.getAttribute('viewBox');
            const w = svgRoot.getAttribute('width');
            const h = svgRoot.getAttribute('height');
            
            if (vb) {
                const parts = vb.split(/[\s,]+/).map(parseFloat);
                if (parts.length === 4) {
                    pageW = parts[2];
                    pageH = parts[3];
                }
            } else if (w && h) {
                pageW = parseFloat(w);
                pageH = parseFloat(h);
            }
        }

        const elements = doc.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
        
        let validElements = [];

        elements.forEach((el, index) => {
            if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) return;

            const style = el.getAttribute('style') || '';
            const display = el.getAttribute('display');
            const visibility = el.getAttribute('visibility');
            if (
                display === 'none' || 
                visibility === 'hidden' || 
                visibility === 'collapse' ||
                style.includes('display:none') || 
                style.includes('display: none') || 
                style.includes('visibility:hidden')
            ) return;

            if (el.tagName.toLowerCase() === 'rect' && pageW > 0 && pageH > 0) {
                const x = parseFloat(el.getAttribute('x') || 0);
                const y = parseFloat(el.getAttribute('y') || 0);
                const w = parseFloat(el.getAttribute('width') || 0);
                const h = parseFloat(el.getAttribute('height') || 0);
                
                const matchesSize = (Math.abs(w - pageW) < 1.0) && (Math.abs(h - pageH) < 1.0);
                const isAtOrigin = (Math.abs(x) < 1.0) && (Math.abs(y) < 1.0);
                
                if (matchesSize && isAtOrigin) return; 
            }
            
            validElements.push({ el, originalIndex: index });
        });

        // Sort elements: crease shapes first
        validElements.sort((a, b) => {
            const methodA = a.el.getAttribute('data-method') || 'thru_cut';
            const methodB = b.el.getAttribute('data-method') || 'thru_cut';
            if (methodA === 'crease' && methodB !== 'crease') return -1;
            if (methodA !== 'crease' && methodB === 'crease') return 1;
            return a.originalIndex - b.originalIndex;
        });

        const hasCrease = validElements.some(v => (v.el.getAttribute('data-method') || 'thru_cut') === 'crease');
        const hasCut = validElements.some(v => (v.el.getAttribute('data-method') || 'thru_cut') !== 'crease');
        let injectedToolChange = false;

        validElements.forEach(({ el, originalIndex }) => {
            const method = el.getAttribute('data-method') || 'thru_cut';

            // Inject tool change pause if transitioning from crease to cut
            if (!injectedToolChange && hasCrease && hasCut && method !== 'crease') {
                this.rawSegments.push({ type: 'meta', command: '; --- TOOL CHANGE ---' });
                this.rawSegments.push({ type: 'meta', command: 'PAUSE_FOR_TOOL_CHANGE' });
                injectedToolChange = true;
            }

            let offsetX = 0;
            let offsetY = 0;
            
            let parent = el;
            while(parent && parent.tagName !== 'svg') {
                const transform = parent.getAttribute('transform');
                if (transform) {
                    const translateMatch = transform.match(/translate\(\s*([-+]?[\d.]+)\s*[\s, ]\s*([-+]?[\d.]+)\s*\)/);
                    if (translateMatch) {
                        offsetX += parseFloat(translateMatch[1]);
                        offsetY += parseFloat(translateMatch[2]);
                    }
                }
                parent = parent.parentNode;
            }

            const commands = this.parseElement(el);
            if (offsetX !== 0 || offsetY !== 0) {
                commands.forEach(cmd => {
                    if (cmd.args && cmd.args.length >= 2) {
                        for (let k = 0; k < cmd.args.length; k += 2) {
                            cmd.args[k] += offsetX;
                            cmd.args[k+1] += offsetY;
                        }
                    }
                });
            }

            const shapeId = `shape_${originalIndex}`;
            this.rawSegments.push({ type: 'meta', command: `; SHAPE_START id=${shapeId} method=${method}` });
            this.generateTrajectory(commands, state, method);
            this.rawSegments.push({ type: 'meta', command: `; SHAPE_END` });
        });
        
    } else {
        const pathRegex = /<path[^>]*\bd=[\"']([^\"']+)["']/gi;
        let match;
        let validElements = [];
        let index = 0;
        while ((match = pathRegex.exec(svgContent)) !== null) {
          const d = match[1];
          const methodMatch = match[0].match(/data-method=[\"']([^\"']+)["']/i);
          const method = methodMatch ? methodMatch[1] : 'thru_cut';
          validElements.push({ d, method, originalIndex: index++ });
        }

        // Sort: crease first
        validElements.sort((a, b) => {
            if (a.method === 'crease' && b.method !== 'crease') return -1;
            if (a.method !== 'crease' && b.method === 'crease') return 1;
            return a.originalIndex - b.originalIndex;
        });

        const hasCrease = validElements.some(v => v.method === 'crease');
        const hasCut = validElements.some(v => v.method !== 'crease');
        let injectedToolChange = false;

        validElements.forEach(v => {
            if (!injectedToolChange && hasCrease && hasCut && v.method !== 'crease') {
                this.rawSegments.push({ type: 'meta', command: '; --- TOOL CHANGE ---' });
                this.rawSegments.push({ type: 'meta', command: 'PAUSE_FOR_TOOL_CHANGE' });
                injectedToolChange = true;
            }

            const commands = this.parsePathData(v.d);
            this.rawSegments.push({ type: 'meta', command: `; SHAPE_START id=path_${v.originalIndex} method=${v.method}` });
            this.generateTrajectory(commands, state, v.method);
            this.rawSegments.push({ type: 'meta', command: `; SHAPE_END` });
        });
    }

    // Return home
    this.rawSegments.push({ type: 'meta', command: '; --- RETURN HOME ---' });
    this.generateTrajectory([{ type: 'M', args: [0, 0] }], state, 'thru_cut');
    this.emitPoint(null, null, state, 0, 0, this.zUp, 0, 0, 0, this.homeAngleA);

    // Plan velocities and generate packets
    this.planVelocities();
    const result = this.generateTimedPackets();
    return { preamble: result.textLines, packets: result.packets };
  }

  /**
   * @method parseElement
   * @description Parses a DOM element (path, rect, circle) into a standardized list of path commands.
   * @param {Element} el - The DOM element.
   * @returns {Array} List of path commands.
   */
  parseElement(el) {
      const tagName = el.tagName.toLowerCase();
      if (tagName === 'path') {
          return this.parsePathData(el.getAttribute('d') || '');
      } else if (tagName === 'rect') {
          const x = parseFloat(el.getAttribute('x') || 0);
          const y = parseFloat(el.getAttribute('y') || 0);
          const w = parseFloat(el.getAttribute('width') || 0);
          const h = parseFloat(el.getAttribute('height') || 0);
          return [
              { type: 'M', args: [x, y] },
              { type: 'L', args: [x + w, y] },
              { type: 'L', args: [x + w, y + h] },
              { type: 'L', args: [x, y + h] },
              { type: 'L', args: [x, y] }
          ];
      } else if (tagName === 'circle') {
          const cx = parseFloat(el.getAttribute('cx') || 0);
          const cy = parseFloat(el.getAttribute('cy') || 0);
          const r = parseFloat(el.getAttribute('r') || 0);
          const k = 0.552284749831; 
          return [
              { type: 'M', args: [cx + r, cy] },
              { type: 'C', args: [cx + r, cy + k*r, cx + k*r, cy + r, cx, cy + r] },
              { type: 'C', args: [cx - k*r, cy + r, cx - r, cy + k*r, cx - r, cy] },
              { type: 'C', args: [cx - r, cy - k*r, cx - k*r, cy - r, cx, cy - r] },
              { type: 'C', args: [cx + k*r, cy - r, cx + r, cy - k*r, cx + r, cy] }
          ];
      } else if (tagName === 'ellipse') {
          const cx = parseFloat(el.getAttribute('cx') || 0);
          const cy = parseFloat(el.getAttribute('cy') || 0);
          const rx = parseFloat(el.getAttribute('rx') || 0);
          const ry = parseFloat(el.getAttribute('ry') || 0);
          const k = 0.552284749831;
          return [
              { type: 'M', args: [cx + rx, cy] },
              { type: 'C', args: [cx + rx, cy + k*ry, cx + k*rx, cy + ry, cx, cy + ry] },
              { type: 'C', args: [cx - k*rx, cy + ry, cx - rx, cy + k*ry, cx - rx, cy] },
              { type: 'C', args: [cx - rx, cy - k*ry, cx - k*rx, cy - ry, cx, cy - ry] },
              { type: 'C', args: [cx + k*rx, cy - ry, cx + rx, cy - k*ry, cx + rx, cy] }
          ];
      } else if (tagName === 'line') {
          const x1 = parseFloat(el.getAttribute('x1') || 0);
          const y1 = parseFloat(el.getAttribute('y1') || 0);
          const x2 = parseFloat(el.getAttribute('x2') || 0);
          const y2 = parseFloat(el.getAttribute('y2') || 0);
          return [
              { type: 'M', args: [x1, y1] },
              { type: 'L', args: [x2, y2] }
          ];
      } else if (tagName === 'polyline' || tagName === 'polygon') {
          const pointsStr = el.getAttribute('points') || '';
          const points = pointsStr.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
          if (points.length < 2) return [];
          const cmds = [{ type: 'M', args: [points[0], points[1]] }];
          for (let i = 2; i < points.length; i += 2) {
              if (i + 1 < points.length) cmds.push({ type: 'L', args: [points[i], points[i+1]] });
          }
          if (tagName === 'polygon') {
              cmds.push({ type: 'Z', args: [] });
          }
          return cmds;
      }
      return [];
  }

  /**
   * @method parsePathData
   * @description Parses SVG 'd' attribute string into command objects.
   * @param {string} d - The path data string.
   * @returns {Array} Array of command objects {type: 'M', args: [...]}.
   */
  parsePathData(d) {
      const tokens = d.match(/([a-zA-Z])|([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g);
     if (!tokens) return [];
     return this.parseTokens(tokens);
  }

  /**
   * @method parseTokens
   * @description Internal helper to consume tokens and build command list.
   * @param {Array} tokens - List of string tokens.
   * @returns {Array} Commands.
   */
  parseTokens(tokens) {
      const commands = [];
      let i = 0;
      let lastCommand = null;

      const eat = (n) => {
          const args = [];
          for(let k=0; k<n; k++) {
              if (i >= tokens.length) break;
              args.push(parseFloat(tokens[i++]));
          }
          return args;
      };

      while(i < tokens.length) {
          let token = tokens[i];
          let cmdType = token;
          
          if (/^[a-zA-Z]$/.test(token)) {
              cmdType = token;
              i++;
          } else {
              if (lastCommand) {
                  if (lastCommand.toUpperCase() === 'M') {
                      cmdType = (lastCommand === 'M') ? 'L' : 'l';
                  } else {
                      cmdType = lastCommand;
                  }
              } else {
                  i++; continue;
              }
          }

          lastCommand = cmdType;
          let args = [];
          switch(cmdType.toUpperCase()) {
              case 'M': args = eat(2); break;
              case 'L': args = eat(2); break;
              case 'H': args = eat(1); break;
              case 'V': args = eat(1); break;
              case 'C': args = eat(6); break;
              case 'S': args = eat(4); break;
              case 'Q': args = eat(4); break;
              case 'T': args = eat(2); break;
              case 'A': args = eat(7); break;
              case 'Z': args = []; break;
              default: i++; break;
          }
          commands.push({ type: cmdType, args: args });
      }
      return commands;
  }

  /**
   * @method generateTrajectory
   * @description Converts parsed SVG commands into Trajectory CSV lines.
   * @param {Array} commands - List of parsed commands.
   * @param {Object} state - The machine state.
   * @param {string} method - The shape cutting method (crease, thru_cut, off_base).
   * @returns {Object} { packets: Array of Uint8Array, textLines: Array of string }
   */
  generateTrajectory(commands, state = null, method = 'thru_cut') {
    const packets = [];
    const textLines = [];
    let cur = new Vector2(0, 0);
    let start = new Vector2(0, 0); 
    let lastControl = new Vector2(0, 0);
    let lastCmdType = '';
    
    // Determine target Z based on method
    // zDown is the base depth. off_base should be slightly higher, crease should be even higher.
    const targetZDown = method === 'off_base' ? this.zDown + 1 : (method === 'crease' ? this.zDown + 2 : this.zDown);

    if (!state) {
        state = {
            isPenDown: false,
            machineX: 0,
            machineY: 0,
            machineZ: this.zUp,
            machineA: this.homeAngleA
        };
    }

    commands.forEach(cmd => {
        const isRelative = (cmd.type === cmd.type.toLowerCase());
        const type = cmd.type.toUpperCase();
        const args = cmd.args;

        const getPt = (idx) => isRelative 
            ? new Vector2(cur.x + args[idx], cur.y + args[idx+1]) 
            : new Vector2(args[idx], args[idx+1]);

        switch (type) {
            case 'M': {
                const p = getPt(0);
                
                if (state.isPenDown) {
                    this.emitPoint(packets, textLines, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
                }
                
                // Segment the travel move to avoid large step values (>32000) over long distances
                this.emitLineSubdivided(packets, textLines, state, p, this.zUp);
                
                cur = p;
                start = p;
                lastControl = p;
                break;
            }
            case 'L': {
                const p = getPt(0);
                this.emitLineSubdivided(packets, textLines, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'H': {
                const x = isRelative ? cur.x + args[0] : args[0];
                const p = new Vector2(x, cur.y);
                this.emitLineSubdivided(packets, textLines, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'V': {
                const y = isRelative ? cur.y + args[0] : args[0];
                const p = new Vector2(cur.x, y);
                this.emitLineSubdivided(packets, textLines, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'C': {
                const c1 = getPt(0);
                const c2 = getPt(2);
                const p = getPt(4);
                const bezier = new CubicBezier(cur, c1, c2, p);
                this.flattenBezier(packets, textLines, state, bezier, targetZDown);
                cur = p;
                lastControl = c2;
                break;
            }
            case 'S': {
                let c1 = cur;
                if (lastCmdType === 'C' || lastCmdType === 'S') {
                    c1 = cur.add(cur.sub(lastControl));
                }
                const c2 = getPt(0);
                const p = getPt(2);
                const bezier = new CubicBezier(cur, c1, c2, p);
                this.flattenBezier(packets, textLines, state, bezier, targetZDown);
                cur = p;
                lastControl = c2;
                break;
            }
            case 'Q': {
                const c1 = getPt(0);
                const p = getPt(2);
                const cp1 = cur.add(c1.sub(cur).mul(2/3));
                const cp2 = p.add(c1.sub(p).mul(2/3));
                const bezier = new CubicBezier(cur, cp1, cp2, p);
                this.flattenBezier(packets, textLines, state, bezier, targetZDown);
                cur = p;
                lastControl = c1;
                break;
            }
            case 'T': {
                let c1 = cur;
                 if (lastCmdType === 'Q' || lastCmdType === 'T') {
                    c1 = cur.add(cur.sub(lastControl));
                }
                const p = getPt(0);
                 const cp1 = cur.add(c1.sub(cur).mul(2/3));
                const cp2 = p.add(c1.sub(p).mul(2/3));
                const bezier = new CubicBezier(cur, cp1, cp2, p);
                this.flattenBezier(packets, textLines, state, bezier, targetZDown);
                cur = p;
                lastControl = c1;
                break;
            }
            case 'Z': {
                this.emitLineSubdivided(packets, textLines, state, start, targetZDown);
                cur = start;
                lastControl = start;
                break;
            }
             case 'A': {
                 const p = getPt(5);
                 this.emitLineSubdivided(packets, textLines, state, p, targetZDown);
                 cur = p;
                 lastControl = p;
                 break;
             }
        }
        lastCmdType = type;
    });

    if (state.isPenDown) {
        this.emitPoint(packets, textLines, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
        state.isPenDown = false;
    }

    this.emitPoint(packets, textLines, state, state.machineX, state.machineY, this.zUp, 0, 0, 0, this.homeAngleA);

    return { packets, textLines };
    return { packets, textLines, rawSegments: this.rawSegments };
  }

  /**
   * @method emitPoint
   * @description Formats and emits a single row of CSV data, automatically handling Tangential Knife rotations.
   */
  emitPoint(packets, textLines, state, x, y, z, vx, vy, vz, forcedAngle = null) {
      // Clamp coordinates to cutting bed bounds
      x = Math.max(0, Math.min(this.bedW, x));
      y = Math.max(0, Math.min(this.bedH, y));

      const dx = x - state.machineX;
      const dy = y - state.machineY;
      const dSq = dx * dx + dy * dy;
      
      const forcedDiff = forcedAngle === null
          ? 0
          : Math.abs((((forcedAngle - state.machineA) + 180) % 360 + 360) % 360 - 180);

      // Skip if effectively identical position and height and no angular correction requested
      if (dSq < 0.000001 && Math.abs(z - state.machineZ) < 0.001 && forcedDiff < 0.001) return;

      let targetA = state.machineA;
      if (forcedAngle !== null) {
          targetA = ((forcedAngle % 360) + 360) % 360;
      } else if (vx !== undefined && vy !== undefined && (Math.abs(vx) > 0.000001 || Math.abs(vy) > 0.000001)) {
          // Use exact analytical velocity when available to eliminate aliasing/jitter
          targetA = Math.atan2(vy, vx) * 180 / Math.PI;
          targetA = ((targetA % 360) + 360) % 360;
      } else if (dSq >= 0.000001) {
          // Fallback to secant approximation for tiny straight lines without velocity
          targetA = Math.atan2(dy, dx) * 180 / Math.PI;
          targetA = ((targetA % 360) + 360) % 360;
      }
      
      let diff = targetA - state.machineA;
      diff = ((diff + 180) % 360 + 360) % 360 - 180;

      // Helper to emit a point and track relative Z
      const pushLine = (targetX, targetY, targetZ, targetVx, targetVy, targetVz, targetAngle) => {
          const angleDelta = ((targetAngle - state.machineA + 180) % 360 + 360) % 360 - 180;
          const resolvedTargetAngle = state.machineA + angleDelta;

          // Prevent fractional drift by comparing absolute rounded steps
          const currentXSteps = Math.round(state.machineX * this.stepsPerMM_X);
          const targetXSteps = Math.round(targetX * this.stepsPerMM_X);
          const relativeXStep = targetXSteps - currentXSteps;

          const currentYSteps = Math.round(state.machineY * this.stepsPerMM_Y);
          const targetYSteps = Math.round(targetY * this.stepsPerMM_Y);
          const relativeYStep = targetYSteps - currentYSteps;

          const currentZSteps = Math.round(state.machineZ * this.stepsPerMM_Z);
          const targetZSteps = Math.round(targetZ * this.stepsPerMM_Z);
          const relativeZStep = currentZSteps - targetZSteps;

          const currentASteps = Math.round(state.machineA * this.stepsPerDeg_A);
          const targetASteps = Math.round(resolvedTargetAngle * this.stepsPerDeg_A);
          const relativeAStep = targetASteps - currentASteps;
          
          const maxAbsStep = Math.max(
              Math.abs(relativeXStep),
              Math.abs(relativeYStep),
              Math.abs(relativeZStep),
              Math.abs(relativeAStep)
          );

          // Subdivide moves recursively if they exceed firmware limits
          if (maxAbsStep > this.maxSteps) {
              const segments = Math.ceil(maxAbsStep / this.maxSteps);
              const stepX = (targetX - state.machineX) / segments;
              const stepY = (targetY - state.machineY) / segments;
              const stepZ = (targetZ - state.machineZ) / segments;
              const stepA = angleDelta / segments;
              
              let currX = state.machineX;
              let currY = state.machineY;
              let currZ = state.machineZ;
              let currA = state.machineA;
              
              for (let i = 1; i <= segments; i++) {
                  currX += stepX;
                  currY += stepY;
                  currZ += stepZ;
                  currA += stepA;
                  pushLine(currX, currY, currZ, targetVx, targetVy, targetVz, currA);
              }
              return;
          }
          
          // If there is no movement at all, don't emit the line (but update state)
          if (relativeXStep === 0 && relativeYStep === 0 && relativeZStep === 0 && relativeAStep === 0) {
              state.machineX = targetX;
              state.machineY = targetY;
              state.machineZ = targetZ;
              state.machineA = resolvedTargetAngle;
              return;
          }
          
          this.rawSegments.push({
              type: 'motion',
              x1: state.machineX,
              y1: state.machineY,
              z1: state.machineZ,
              a1: state.machineA,
              x2: targetX,
              y2: targetY,
              z2: targetZ,
              a2: resolvedTargetAngle,
              relativeXStep,
              relativeYStep,
              relativeZStep,
              relativeAStep,
              dx: targetX - state.machineX,
              dy: targetY - state.machineY,
              dz: targetZ - state.machineZ,
              da: angleDelta,
              length: Math.sqrt((targetX - state.machineX)**2 + (targetY - state.machineY)**2),
              feedRate: (targetVx !== 0 || targetVy !== 0) ? Math.sqrt(targetVx*targetVx + targetVy*targetVy) : (targetVz !== 0 ? Math.abs(targetVz) : this.feedRate)
          });
          
          state.machineX = targetX;
          state.machineY = targetY;
          state.machineZ = targetZ;
          state.machineA = resolvedTargetAngle;
      };

      // Handle Plunge/Lift & Tangential knife sharp corners
      if (!state.isPenDown && z !== this.zUp) {
          // Orient (rotation only, no Z move yet)
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, 0, targetA);
          // Plunge
          pushLine(state.machineX, state.machineY, z, 0, 0, this.feedRate, targetA);
          state.isPenDown = true;
      } else if (state.isPenDown && Math.abs(diff) > this.angleThreshold && z !== this.zUp) {
          // Lift, Orient, Plunge sequence for sharp corners
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate, state.machineA);
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, 0, targetA);
          pushLine(state.machineX, state.machineY, z, 0, 0, this.feedRate, targetA);
      }

      // Purely Z-up moves should keep current orientation
      if (z === this.zUp) {
          state.isPenDown = false;
          targetA = state.machineA; 
      }

      // Output scaled steps for the target point
      pushLine(x, y, z, vx, vy, vz, targetA);
  }

  /**
   * @method emitLineSubdivided
   * @description Helper to draw a straight line subdivided into exactly segmentLength intervals.
   */
  emitLineSubdivided(packets, textLines, state, rawP, targetZ) {
      const startX = state.machineX;
      const startY = state.machineY;
      const zHeight = targetZ !== undefined ? targetZ : this.zDown;
      
      const p = this.transform(rawP);
      
      const dx = p.x - startX;
      const dy = p.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist < 0.000001) {
          if (Math.abs(zHeight - state.machineZ) > 0.001) {
              this.emitPoint(packets, textLines, state, p.x, p.y, zHeight, 0, 0, 0);
          }
          return;
      }

      const numSegments = Math.ceil(dist / this.segmentLength);
      
      // Compute raw velocity from points
      let vx = dx; 
      let vy = dy;
      let vz = 0;
      
      // Normalize and apply target feedrate (mm/sec)
      const mag = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (mag > 0) {
          vx = (vx / mag) * this.feedRate;
          vy = (vy / mag) * this.feedRate;
          vz = (vz / mag) * this.feedRate;
      }

      for (let i = 1; i <= numSegments; i++) {
          const t = i / numSegments;
          const currX = startX + dx * t;
          const currY = startY + dy * t;
          
          this.emitPoint(packets, textLines, state, currX, currY, zHeight, vx, vy, vz);
      }
  }

  /**
   * @method flattenBezier
   * @description Subdivides a Bezier curve into equidistant physical segments.
   */
  flattenBezier(packets, textLines, state, bezier, targetZ) {
      const steps = 50; 
      const lut = bezier.getLUT(steps);
      const totalLength = lut[lut.length - 1].dist;

      const numSegments = Math.ceil(totalLength / this.segmentLength);
      const zHeight = targetZ !== undefined ? targetZ : this.zDown;

      if (numSegments <= 0) {
          this.emitLineSubdivided(packets, textLines, state, bezier.p3, zHeight);
          return;
      }

      const actualStep = totalLength / numSegments;

      for (let i = 1; i <= numSegments; i++) {
          const targetDist = i * actualStep;

          let tFound = 1.0;
          for (let k = 0; k < lut.length - 1; k++) {
              if (lut[k].dist <= targetDist && lut[k+1].dist >= targetDist) {
                  const dStart = lut[k].dist;
                  const dEnd = lut[k+1].dist;
                  const tStart = lut[k].t;
                  const tEnd = lut[k+1].t;
                  
                  const ratio = (targetDist - dStart) / (dEnd - dStart);
                  tFound = tStart + (tEnd - tStart) * ratio;
                  break;
              }
          }

          const pRaw = bezier.sample(tFound);
          const p = this.transform(pRaw); 
          
          const vRaw = bezier.getVelocity(tFound);
          let vx = this.flipX ? -vRaw.x * this.scale : vRaw.x * this.scale;
          let vy = this.flipY ? -vRaw.y * this.scale : vRaw.y * this.scale;
          let vz = 0;
          
          // Normalize and apply target feedrate (mm/sec)
          const mag = Math.sqrt(vx*vx + vy*vy + vz*vz);
          if (mag > 0) {
              vx = (vx / mag) * this.feedRate;
              vy = (vy / mag) * this.feedRate;
              vz = (vz / mag) * this.feedRate;
          }

          this.emitPoint(packets, textLines, state, p.x, p.y, zHeight, vx, vy, vz);
      }
  }

  planVelocities() {
      // 1. Identify continuous blocks of XY motion segments (length > 0)
      const blocks = [];
      let currentBlock = [];

      for (let i = 0; i < this.rawSegments.length; i++) {
          const seg = this.rawSegments[i];
          if (seg.type === 'motion') {
              // Calculate segment properties
              let length = seg.length;
              // If length is 0 but it has XY steps, resolve length
              if (length === 0 && (seg.relativeXStep !== 0 || seg.relativeYStep !== 0)) {
                  length = Math.sqrt((seg.relativeXStep / this.stepsPerMM_X)**2 + (seg.relativeYStep / this.stepsPerMM_Y)**2);
              }
              seg.length = length;

              // Determine max speed (vMax)
              if (length > 0) {
                  seg.vMax = Math.min(seg.feedRate, this.maxXYSpeed);
                  currentBlock.push(seg);
              } else {
                  // Non-XY motion (Z-only, A-only, etc.)
                  // Closes the current XY block
                  if (currentBlock.length > 0) {
                      blocks.push(currentBlock);
                      currentBlock = [];
                  }
                  // Setup Z-only/A-only speed
                  if (seg.relativeZStep !== 0) {
                      seg.vMax = this.maxZSpeed;
                  } else if (seg.relativeAStep !== 0) {
                      seg.vMax = this.maxRotationalSpeed;
                  } else {
                      seg.vMax = 0;
                  }
                  seg.entrySpeed = seg.vMax;
                  seg.exitSpeed = seg.vMax;
              }
          } else {
              // Meta segments also close the current XY block
              if (currentBlock.length > 0) {
                  blocks.push(currentBlock);
                  currentBlock = [];
              }
          }
      }
      if (currentBlock.length > 0) {
          blocks.push(currentBlock);
      }

      // 2. Plan each XY block
      for (const block of blocks) {
          const N = block.length;
          if (N === 0) continue;

          // Compute junction limit speeds
          for (let i = 0; i < N - 1; i++) {
              const S1 = block[i];
              const S2 = block[i + 1];

              // Unit direction vectors
              const u1_x = S1.dx / S1.length;
              const u1_y = S1.dy / S1.length;
              const u2_x = S2.dx / S2.length;
              const u2_y = S2.dy / S2.length;

              const dot = u1_x * u2_x + u1_y * u2_y;
              // GRBL junction deviation calculation
              // junctionCosTheta = -dot
              const cosTheta = Math.max(-1.0, Math.min(1.0, -dot));

              let junctionSpeed = 0.0;
              if (cosTheta > 0.999999) {
                  // Sharp corner
                  junctionSpeed = 0.0;
              } else if (cosTheta < -0.999999) {
                  // Collinear segment
                  junctionSpeed = Math.min(S1.vMax, S2.vMax);
              } else {
                  const sinThetaD2 = Math.sqrt(0.5 * (1.0 - cosTheta));
                  const limitSpeedSqr = (this.acceleration * this.junctionDeviation * sinThetaD2) / (1.0 - sinThetaD2);
                  junctionSpeed = Math.sqrt(limitSpeedSqr);
                  junctionSpeed = Math.min(junctionSpeed, S1.vMax, S2.vMax);
              }
              S1.junctionLimit = junctionSpeed;
          }

          // Initialize speeds
          for (let i = 0; i < N; i++) {
              block[i].entrySpeed = block[i].vMax;
              block[i].exitSpeed = block[i].vMax;
          }

          // Apply junction limits
          for (let i = 0; i < N - 1; i++) {
              const limit = block[i].junctionLimit;
              block[i].exitSpeed = Math.min(block[i].exitSpeed, limit);
              block[i + 1].entrySpeed = Math.min(block[i + 1].entrySpeed, limit);
          }

          // Start and end velocities must be 0
          block[0].entrySpeed = 0.0;
          block[N - 1].exitSpeed = 0.0;

          // Backward Pass: Exit-to-Entry deceleration planning
          for (let i = N - 1; i >= 0; i--) {
              const seg = block[i];
              const maxEntrySpeed = Math.sqrt(seg.exitSpeed * seg.exitSpeed + 2.0 * this.acceleration * seg.length);
              seg.entrySpeed = Math.min(seg.entrySpeed, maxEntrySpeed);
              
              if (i > 0) {
                  block[i - 1].exitSpeed = Math.min(block[i - 1].exitSpeed, seg.entrySpeed);
              }
          }

          // Forward Pass: Entry-to-Exit acceleration planning
          for (let i = 0; i < N; i++) {
              const seg = block[i];
              const maxExitSpeed = Math.sqrt(seg.entrySpeed * seg.entrySpeed + 2.0 * this.acceleration * seg.length);
              seg.exitSpeed = Math.min(seg.exitSpeed, maxExitSpeed);

              if (i < N - 1) {
                  block[i + 1].entrySpeed = Math.min(block[i + 1].entrySpeed, seg.exitSpeed);
              }
          }
      }
  }

  generateTimedPackets() {
      const packets = [];
      const textLines = [];

      for (let i = 0; i < this.rawSegments.length; i++) {
          const seg = this.rawSegments[i];
          if (seg.type === 'meta') {
              textLines.push(seg.command);
          } else if (seg.type === 'motion') {
              const relativeXStep = seg.relativeXStep;
              const relativeYStep = seg.relativeYStep;
              const relativeZStep = seg.relativeZStep;
              const relativeAStep = seg.relativeAStep;

              const maxAbsStep = Math.max(
                  Math.abs(relativeXStep),
                  Math.abs(relativeYStep),
                  Math.abs(relativeZStep),
                  Math.abs(relativeAStep)
              );

              if (maxAbsStep === 0) continue;

              let duration = 0;
              const length = seg.length;

              if (length > 0) {
                  // XY motion segment
                  const vAvg = Math.max(0.1, (seg.entrySpeed + seg.exitSpeed) / 2);
                  duration = length / vAvg;
              } else if (relativeZStep !== 0) {
                  // Z-only motion segment with trapezoidal acceleration ramp from 0 to 0
                  const sZ = Math.abs(relativeZStep) / this.stepsPerMM_Z;
                  const vMax = Math.min(seg.feedRate, this.maxZSpeed);
                  if (sZ > 0 && vMax > 0) {
                      const vPeak = Math.max(0.1, Math.min(vMax, Math.sqrt(this.accelerationZ * sZ)));
                      duration = (vPeak / this.accelerationZ) + (sZ / vPeak);
                  }
              }

              if (relativeAStep !== 0) {
                  if (duration > 0) {
                      // A rotates concurrently with other axes
                  } else {
                      // A-only motion segment with trapezoidal acceleration ramp from 0 to 0
                      const sA = Math.abs(relativeAStep) / this.stepsPerDeg_A;
                      if (sA > 0) {
                          const vPeak = Math.max(0.1, Math.min(this.maxRotationalSpeed, Math.sqrt(this.accelerationA * sA)));
                          duration = (vPeak / this.accelerationA) + (sA / vPeak);
                      }
                  }
              }

              // Enforce physical maximum speeds per-axis to prevent motor stalling
              if (duration > 0) {
                  const maxSpsX = this.maxXSpeed * this.stepsPerMM_X;
                  const maxSpsY = this.maxYSpeed * this.stepsPerMM_Y;
                  const maxSpsZ = this.maxZSpeed * this.stepsPerMM_Z;
                  const maxSpsA = this.maxRotationalSpeed * this.stepsPerDeg_A;

                  const currentSpsX = Math.abs(relativeXStep) / duration;
                  if (currentSpsX > maxSpsX) duration = Math.abs(relativeXStep) / maxSpsX;
                  
                  const currentSpsY = Math.abs(relativeYStep) / duration;
                  if (currentSpsY > maxSpsY) duration = Math.abs(relativeYStep) / maxSpsY;
                  
                  const currentSpsZ = Math.abs(relativeZStep) / duration;
                  if (currentSpsZ > maxSpsZ) duration = Math.abs(relativeZStep) / maxSpsZ;
                  
                  const currentSpsA = Math.abs(relativeAStep) / duration;
                  if (currentSpsA > maxSpsA) duration = Math.abs(relativeAStep) / maxSpsA;
              }

              let interval = 0;
              if (duration > 0) {
                  interval = Math.max(1, Math.round((150_000_000 * duration) / maxAbsStep));
              } else {
                  interval = 150_000_000;
              }

              // F5: Hard-cap physical step rate to 75,000 steps/sec (2,000 ticks minimum interval)
              interval = Math.max(2000, interval);

              const pkt = packMicrosegment(relativeXStep, relativeYStep, relativeZStep, relativeAStep, interval, 0, 0);
              packets.push(pkt);

              // Include debugging info with entry/exit speeds if it's an XY move
              const speedInfo = length > 0
                  ? ` vEntry:${seg.entrySpeed.toFixed(1)} vExit:${seg.exitSpeed.toFixed(1)}`
                  : '';
              textLines.push(`; MOVE X:${seg.x2.toFixed(3)} Y:${seg.y2.toFixed(3)} Z:${seg.z2.toFixed(3)} A:${seg.a2.toFixed(3)} (Interval: ${interval})${speedInfo}`);
          }
      }

      return { packets, textLines };
  }
}

export default SvgConverter;
export { Vector2, CubicBezier, SvgConverter };
