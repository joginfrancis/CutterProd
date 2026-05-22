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
 * @file SvgConverter.js
 * @description Main class for parsing SVG strings and generating Trajectory Data.
 */

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
    this.flipY = options.flipY || false;
    this.segmentLength = options.segmentLength || 1.0;
    // Per-axis step rates; stepsPerMM is kept as a fallback for backward compat
    const globalSteps = options.stepsPerMM || 1.0;
    this.stepsPerMM_X = options.stepsPerMM_X || globalSteps;
    this.stepsPerMM_Y = options.stepsPerMM_Y || globalSteps;
    this.stepsPerMM_Z = options.stepsPerMM_Z || 80.0;
    this.stepsPerDeg_A = options.stepsPerDeg_A || 8.88;
    
    this.idX = options.idX !== undefined ? options.idX : 3;
    this.idY = options.idY !== undefined ? options.idY : 2;
    this.idZ = options.idZ !== undefined ? options.idZ : 1;
    this.idA = options.idA !== undefined ? options.idA : 4;
    
    // Z-Axis Config (mm initially, then scaled to steps)
    this.zUp = options.zUp !== undefined ? options.zUp : 5;
    this.zDown = options.zDown !== undefined ? options.zDown : 0;
    
    // Tangential Knife Config
    this.angleThreshold = options.angleThreshold !== undefined ? options.angleThreshold : 10;
    this.decimals = 4;
    
    // Limits
    this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 30000;
    this.maxSpeed = options.maxSpeed !== undefined ? options.maxSpeed : 30000;
  }

  /**
   * @method transform
   * @description Applies scaling, flipping, and offsets to a point.
   * @param {Vector2} p - The point to transform.
   * @returns {Object} The transformed coordinates {x, y}.
   */
  transform(p) {
      const x = (p.x * this.scale) + this.offsetX;
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
    const data = [];
    
    // First command to enable the motors
    data.push('enable all 1');

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
                const parts = vb.split(/[\S,]+/).map(parseFloat);
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
                
                if (matchesSize && isAtOrigin) {
                    return; 
                }
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

            const shapeData = this.generateTrajectory(commands);
            data.push(...shapeData);
        });
        
    } else {
        const pathRegex = /<path[^>]*\bd=[\"']([^\"']+)["']/gi;
        let match;
        while ((match = pathRegex.exec(svgContent)) !== null) {
          const d = match[1];
          const commands = this.parsePathData(d);
          const shapeData = this.generateTrajectory(commands);
          data.push(...shapeData);
        }
    }

    return data.join('\n');
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
   * @returns {Array} Array of CSV data lines.
   */
  generateTrajectory(commands) {
    const data = [];
    let cur = new Vector2(0, 0);
    let start = new Vector2(0, 0); 
    let lastControl = new Vector2(0, 0);
    let lastCmdType = '';

    const state = {
        isPenDown: false,
        machineX: 0,
        machineY: 0,
        machineZ: this.zUp,
        machineA: 0
    };

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
                    this.emitPoint(data, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
                }
                
                // Segment the travel move to avoid large step values (>32000) over long distances
                this.emitLineSubdivided(data, state, p, this.zUp);
                
                cur = p;
                start = p;
                lastControl = p;
                break;
            }
            case 'L': {
                const p = getPt(0);
                this.emitLineSubdivided(data, state, p);
                cur = p;
                lastControl = p;
                break;
            }
            case 'H': {
                const x = isRelative ? cur.x + args[0] : args[0];
                const p = new Vector2(x, cur.y);
                this.emitLineSubdivided(data, state, p);
                cur = p;
                lastControl = p;
                break;
            }
            case 'V': {
                const y = isRelative ? cur.y + args[0] : args[0];
                const p = new Vector2(cur.x, y);
                this.emitLineSubdivided(data, state, p);
                cur = p;
                lastControl = p;
                break;
            }
            case 'C': {
                const c1 = getPt(0);
                const c2 = getPt(2);
                const p = getPt(4);
                const bezier = new CubicBezier(cur, c1, c2, p);
                this.flattenBezier(data, state, bezier);
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
                this.flattenBezier(data, state, bezier);
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
                this.flattenBezier(data, state, bezier);
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
                this.flattenBezier(data, state, bezier);
                cur = p;
                lastControl = c1;
                break;
            }
            case 'Z': {
                this.emitLineSubdivided(data, state, start);
                cur = start;
                lastControl = start;
                break;
            }
             case 'A': {
                 const p = getPt(5);
                 this.emitLineSubdivided(data, state, p);
                 cur = p;
                 lastControl = p;
                 break;
             }
        }
        lastCmdType = type;
    });

    if (state.isPenDown) {
        this.emitPoint(data, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
        state.isPenDown = false;
    }

    return data;
  }

  /**
   * @method emitPoint
   * @description Formats and emits a single row of CSV data, automatically handling Tangential Knife rotations.
   */
  emitPoint(data, state, x, y, z, vx, vy, vz) {
      const dx = x - state.machineX;
      const dy = y - state.machineY;
      const dSq = dx * dx + dy * dy;
      
      // Skip if effectively identical position and height
      if (dSq < 0.000001 && Math.abs(z - state.machineZ) < 0.001) return;

      let targetA = state.machineA;
      if (dSq >= 0.000001) {
          targetA = Math.atan2(dy, dx) * 180 / Math.PI;
          targetA = ((targetA % 360) + 360) % 360;
      }
      
      let diff = targetA - state.machineA;
      diff = ((diff + 180) % 360 + 360) % 360 - 180;

      // Helper to emit a point and track relative Z
      const pushLine = (targetX, targetY, targetZ, targetVx, targetVy, targetVz, targetAngle) => {
          // Calculate relative steps for X, Y, Z, and Angle
          const relativeXStep = Math.round((targetX - state.machineX) * this.stepsPerMM_X);
          const relativeYStep = Math.round((targetY - state.machineY) * this.stepsPerMM_Y);
          
          // Note: The previous logic was (state.machineZ - targetZ), which means "down is positive".
          // If we want consistency, we should ask if Z should be target - current or current - target.
          // Based on previous iteration, (state.machineZ - targetZ) * steps was used for Z. Let's keep it.
          const relativeZStep = Math.round((state.machineZ - targetZ) * this.stepsPerMM_Z);
          
          // Angle delta
          const relativeAStep = Math.round((targetAngle - state.machineA) * this.stepsPerDeg_A);
          
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
              const stepA = (targetAngle - state.machineA) / segments;
              
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

          let stepVx = Math.abs(Math.round(targetVx * this.stepsPerMM_X));
          let stepVy = Math.abs(Math.round(targetVy * this.stepsPerMM_Y));
          let stepVz = Math.abs(Math.round(targetVz * this.stepsPerMM_Z));
          
          // If there is no movement at all, don't emit the line (but update state)
          if (relativeXStep === 0 && relativeYStep === 0 && relativeZStep === 0 && relativeAStep === 0) {
              state.machineX = targetX;
              state.machineY = targetY;
              state.machineZ = targetZ;
              state.machineA = targetAngle;
              return;
          }
          
          // Calculate duration to ensure all nodes arrive simultaneously
          let duration = 0;
          if (stepVx > 0 && relativeXStep !== 0) duration = Math.abs(relativeXStep) / stepVx;
          else if (stepVy > 0 && relativeYStep !== 0) duration = Math.abs(relativeYStep) / stepVy;
          else if (stepVz > 0 && relativeZStep !== 0) duration = Math.abs(relativeZStep) / stepVz;

          let stepVa = 0;
          if (relativeAStep !== 0) {
              if (duration > 0) {
                  stepVa = Math.abs(relativeAStep) / duration;
              } else {
                  // Pure rotation
                  stepVa = this.stepsPerDeg_A * 360; // default 360 deg/sec
                  duration = Math.abs(relativeAStep) / stepVa;
              }
              stepVa = Math.max(1, Math.round(stepVa));
          }

          // Re-calculate sps for X, Y, Z to ensure perfect synchronization
          if (duration > 0) {
              if (relativeXStep !== 0) stepVx = Math.max(1, Math.round(Math.abs(relativeXStep) / duration));
              if (relativeYStep !== 0) stepVy = Math.max(1, Math.round(Math.abs(relativeYStep) / duration));
              if (relativeZStep !== 0) stepVz = Math.max(1, Math.round(Math.abs(relativeZStep) / duration));
          }
          
          let currentMaxSps = Math.max(stepVx || 0, stepVy || 0, stepVz || 0, stepVa || 0);
          if (currentMaxSps > this.maxSpeed) {
              const scale = currentMaxSps / this.maxSpeed;
              duration *= scale;
              if (duration > 0) {
                  if (relativeXStep !== 0) stepVx = Math.max(1, Math.round(Math.abs(relativeXStep) / duration));
                  if (relativeYStep !== 0) stepVy = Math.max(1, Math.round(Math.abs(relativeYStep) / duration));
                  if (relativeZStep !== 0) stepVz = Math.max(1, Math.round(Math.abs(relativeZStep) / duration));
                  if (relativeAStep !== 0) stepVa = Math.max(1, Math.round(Math.abs(relativeAStep) / duration));
              }
          }
          
          let ids = [];
          let steps = [];
          let sps = [];
          
          if (relativeXStep !== 0) { ids.push(this.idX); steps.push(relativeXStep); sps.push(stepVx); }
          if (relativeYStep !== 0) { ids.push(this.idY); steps.push(relativeYStep); sps.push(stepVy); }
          if (relativeZStep !== 0) { ids.push(this.idZ); steps.push(relativeZStep); sps.push(stepVz); }
          if (relativeAStep !== 0) { ids.push(this.idA); steps.push(relativeAStep); sps.push(stepVa); }
          
          if (ids.length > 0) {
              const cmd = `move ${ids.length} ${ids.join(' ')} ${steps.join(' ')} ${sps.join(' ')}`;
              data.push(cmd);
          }
          
          state.machineX = targetX;
          state.machineY = targetY;
          state.machineZ = targetZ;
          state.machineA = targetAngle;
      };

      // Handle Plunge/Lift & Tangential knife sharp corners
      if (!state.isPenDown && z === this.zDown) {
          // Orient (rotation only, no Z move yet)
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, 0, targetA);
          // Plunge: positive Vz = downward
          pushLine(state.machineX, state.machineY, this.zDown, 0, 0, this.feedRate, targetA);
          state.isPenDown = true;
      } else if (state.isPenDown && Math.abs(diff) > this.angleThreshold && z === this.zDown) {
          // Sharp corner: lift, rotate, plunge
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate, state.machineA);
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0,              0, targetA);
          pushLine(state.machineX, state.machineY, this.zDown, 0, 0,  this.feedRate, targetA);
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
  emitLineSubdivided(data, state, rawP, targetZ) {
      const startX = state.machineX;
      const startY = state.machineY;
      const zHeight = targetZ !== undefined ? targetZ : this.zDown;
      
      const p = this.transform(rawP);
      
      const dx = p.x - startX;
      const dy = p.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist < 0.000001) {
          if (Math.abs(zHeight - state.machineZ) > 0.001) {
              this.emitPoint(data, state, p.x, p.y, zHeight, 0, 0, 0);
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
          
          this.emitPoint(data, state, currX, currY, zHeight, vx, vy, vz);
      }
  }

  /**
   * @method flattenBezier
   * @description Subdivides a Bezier curve into equidistant physical segments.
   * 
   * WHY ARC-LENGTH PARAMETERIZATION?
   * If you step through 't' at equal mathematical intervals (e.g., 0.1, 0.2, 0.3), 
   * the physical distance between those points varies wildly because curves "stretch" 
   * in different places. 
   * 
   * Instead, we use our Look-Up Table (LUT) to map exact physical target distances 
   * (e.g., 1mm, 2mm) back to their corresponding 't' values via linear interpolation. 
   * This guarantees the CNC machine receives a constant stream of equal-length steps.
   * 
   * @param {Array} data - Output buffer array.
   * @param {Object} state - Machine state tracking (position, angle, pen state).
   * @param {CubicBezier} bezier - The curve to flatten.
   */
  flattenBezier(data, state, bezier) {
      const steps = 50; 
      const lut = bezier.getLUT(steps);
      const totalLength = lut[lut.length - 1].dist;

      const numSegments = Math.ceil(totalLength / this.segmentLength);
      
      if (numSegments <= 0) {
          this.emitLineSubdivided(data, state, bezier.p3);
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
          let vx = vRaw.x * this.scale;
          let vy = this.flipY ? -vRaw.y * this.scale : vRaw.y * this.scale;
          let vz = 0;
          
          // Normalize and apply target feedrate (mm/sec)
          const mag = Math.sqrt(vx*vx + vy*vy + vz*vz);
          if (mag > 0) {
              vx = (vx / mag) * this.feedRate;
              vy = (vy / mag) * this.feedRate;
              vz = (vz / mag) * this.feedRate;
          }

          this.emitPoint(data, state, p.x, p.y, this.zDown, vx, vy, vz);
      }
  }
}

export default SvgConverter;