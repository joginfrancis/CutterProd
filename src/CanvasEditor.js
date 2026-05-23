/**
 * ============================================================================
 *                    CANVAS DRAWING EDITOR
 * ============================================================================
 *
 * Provides an interactive drawing surface layered over the cutter bed
 * coordinate space. All drawn shapes are stored as machine-space objects
 * (millimeters) and exported as a well-formed SVG string that feeds directly
 * into the existing SvgConverter pipeline.
 *
 * TOOLS
 * ─────
 *  select  – click / drag to select & move shapes; Delete key removes selection
 *  pencil  – freehand polyline
 *  line    – straight line segment
 *  rect    – axis-aligned rectangle (exported as closed path)
 *  circle  – ellipse approximated by 128-point polyline (closed path)
 *  eraser  – strokes that delete any shape they touch
 *
 * COORDINATE SYSTEM
 * ─────────────────
 * The editor works in *machine millimeters* internally. All interaction
 * events are converted from canvas-pixel → machine-mm using the same
 * mapX/mapY inverse as the Viewer.
 *
 * EXPORT
 * ──────
 * exportAsSVG() returns a ready-to-parse SVG string whose viewBox matches
 * the physical bed dimensions (bedW × bedH mm). The string can be fed
 * directly to handleFile() via a virtual File object.
 * ============================================================================
 */

// ─── Shape Types ──────────────────────────────────────────────────────────────

let _nextId = 1;
function makeId() { return _nextId++; }

function makePencil(points, strokeWidth) {
    return { id: makeId(), type: 'pencil', points: [...points], strokeWidth };
}
function makeLine(x1, y1, x2, y2, strokeWidth) {
    return { id: makeId(), type: 'line', x1, y1, x2, y2, strokeWidth };
}
function makeRect(x, y, w, h, strokeWidth) {
    return { id: makeId(), type: 'rect', x, y, w, h, strokeWidth };
}
function makeCircle(cx, cy, rx, ry, strokeWidth) {
    return { id: makeId(), type: 'circle', cx, cy, rx, ry, strokeWidth };
}
function makeBezier(x1, y1, cx1, cy1, cx2, cy2, x2, y2, strokeWidth) {
    return { id: makeId(), type: 'bezier', x1, y1, cx1, cy1, cx2, cy2, x2, y2, strokeWidth };
}

// ─── SVG Path Serialisation ────────────────────────────────────────────────────

// bedH is required so we can flip Y: SVG Y-down = bedH - machineY
// FileHandler applies flipY=true, so we pre-flip here to cancel it out.
function shapeToPathD(shape, bedH) {
    const fy = y => (bedH - y); // machine Y-up → SVG Y-down
    switch (shape.type) {
        case 'pencil': {
            if (shape.points.length < 2) return '';
            const [first, ...rest] = shape.points;
            return `M ${first.x.toFixed(3)} ${fy(first.y).toFixed(3)} ` +
                rest.map(p => `L ${p.x.toFixed(3)} ${fy(p.y).toFixed(3)}`).join(' ');
        }
        case 'line': {
            return `M ${shape.x1.toFixed(3)} ${fy(shape.y1).toFixed(3)} L ${shape.x2.toFixed(3)} ${fy(shape.y2).toFixed(3)}`;
        }
        case 'rect': {
            const { x, y, w, h } = shape;
            // emit in SVG Y-down order (top edge first)
            return `M ${x.toFixed(3)} ${fy(y+h).toFixed(3)} L ${(x+w).toFixed(3)} ${fy(y+h).toFixed(3)} L ${(x+w).toFixed(3)} ${fy(y).toFixed(3)} L ${x.toFixed(3)} ${fy(y).toFixed(3)} Z`;
        }
        case 'circle': {
            const { cx, cy, rx, ry } = shape;
            const N = 128;
            let d = '';
            for (let i = 0; i <= N; i++) {
                const t = (2 * Math.PI * i) / N;
                const px = (cx + rx * Math.cos(t)).toFixed(3);
                const py = fy(cy + ry * Math.sin(t)).toFixed(3);
                d += i === 0 ? `M ${px} ${py}` : ` L ${px} ${py}`;
            }
            return d + ' Z';
        }
        case 'bezier': {
            const { x1, y1, cx1, cy1, cx2, cy2, x2, y2 } = shape;
            return `M ${x1.toFixed(3)} ${fy(y1).toFixed(3)} C ${cx1.toFixed(3)} ${fy(cy1).toFixed(3)} ${cx2.toFixed(3)} ${fy(cy2).toFixed(3)} ${x2.toFixed(3)} ${fy(y2).toFixed(3)}`;
        }
        default: return '';
    }
}

// ─── Bounding Box ─────────────────────────────────────────────────────────────

function shapeBBox(shape) {
    switch (shape.type) {
        case 'pencil': {
            const xs = shape.points.map(p => p.x);
            const ys = shape.points.map(p => p.y);
            return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        case 'line': {
            return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), w: Math.abs(shape.x2 - shape.x1), h: Math.abs(shape.y2 - shape.y1) };
        }
        case 'rect': {
            return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        }
        case 'circle': {
            return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 };
        }
        case 'bezier': {
            const xs = [shape.x1, shape.cx1, shape.cx2, shape.x2];
            const ys = [shape.y1, shape.cy1, shape.cy2, shape.y2];
            return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        default: return { x: 0, y: 0, w: 0, h: 0 };
    }
}

// ─── Translate a shape by (dx, dy) in machine mm ──────────────────────────────

function translateShape(shape, dx, dy) {
    switch (shape.type) {
        case 'pencil':
            shape.points = shape.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
            break;
        case 'line':
            shape.x1 += dx; shape.y1 += dy;
            shape.x2 += dx; shape.y2 += dy;
            break;
        case 'rect':
            shape.x += dx; shape.y += dy;
            break;
        case 'circle':
            shape.cx += dx; shape.cy += dy;
            break;
        case 'bezier':
            shape.x1 += dx; shape.y1 += dy;
            shape.cx1 += dx; shape.cy1 += dy;
            shape.cx2 += dx; shape.cy2 += dy;
            shape.x2 += dx; shape.y2 += dy;
            break;
    }
}

// ─── Hit Testing ──────────────────────────────────────────────────────────────

function pointNearSegment(px, py, ax, ay, bx, by, tol) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay) < tol;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) < tol;
}

function hitTest(shape, mx, my, tol = 4) {
    const bbox = shapeBBox(shape);
    // Quick AABB reject (with tolerance)
    if (mx < bbox.x - tol || mx > bbox.x + bbox.w + tol ||
        my < bbox.y - tol || my > bbox.y + bbox.h + tol) return false;

    switch (shape.type) {
        case 'pencil': {
            for (let i = 1; i < shape.points.length; i++) {
                const p1 = shape.points[i - 1], p2 = shape.points[i];
                if (pointNearSegment(mx, my, p1.x, p1.y, p2.x, p2.y, tol)) return true;
            }
            return false;
        }
        case 'line':
            return pointNearSegment(mx, my, shape.x1, shape.y1, shape.x2, shape.y2, tol);
        case 'rect': {
            const { x, y, w, h } = shape;
            // Check all 4 sides
            return pointNearSegment(mx, my, x, y, x+w, y, tol) ||
                   pointNearSegment(mx, my, x+w, y, x+w, y+h, tol) ||
                   pointNearSegment(mx, my, x+w, y+h, x, y+h, tol) ||
                   pointNearSegment(mx, my, x, y+h, x, y, tol);
        }
        case 'circle': {
            const { cx, cy, rx, ry } = shape;
            const d = Math.hypot((mx - cx) / rx, (my - cy) / ry);
            return Math.abs(d - 1) < tol / Math.max(rx, ry);
        }
        case 'bezier': {
            // Sample the bezier curve and test proximity to each segment
            const { x1, y1, cx1, cy1, cx2, cy2, x2, y2 } = shape;
            const steps = 40;
            let prev = { x: x1, y: y1 };
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const mt = 1 - t;
                const bx = mt*mt*mt*x1 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x2;
                const by = mt*mt*mt*y1 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y2;
                if (pointNearSegment(mx, my, prev.x, prev.y, bx, by, tol)) return true;
                prev = { x: bx, y: by };
            }
            return false;
        }
        default: return false;
    }
}

// ─── CanvasEditor Class ────────────────────────────────────────────────────────

export class CanvasEditor {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} viewState  - live reference: { scale, offsetX, offsetY, bedW, bedH }
     */
    constructor(canvas, viewState) {
        this.canvas   = canvas;
        this.ctx      = canvas.getContext('2d');
        this.view     = viewState; // shared live object updated from Viewer metrics
        this.shapes   = [];
        this.tool     = 'pencil';
        this.strokeWidth = 1.5; // mm

        // Interaction state
        this._isDown   = false;
        this._draft    = null;   // shape being drawn
        this._draftPts = [];     // pencil points
        this._sel      = [];     // selected shape ids
        this._dragStart = null;  // { mx, my } machine coords at drag start
        this._shapePre  = null;  // deep copy of shapes at drag start
        this._marqueeStart = null; // { mx, my } for rectangular selection
        this._marqueeEnd = null;

        // Bezier tool state — collects clicks: [P0, CP1, CP2, P1]
        this._bezierPts   = [];  // placed anchor/control points so far
        this._bezierMouse = null; // current mouse position for live preview

        // Eraser cursor radius in mm
        this.eraserRadius = 5;

        // Bind events
        this._onDown   = this._onDown.bind(this);
        this._onMove   = this._onMove.bind(this);
        this._onUp     = this._onUp.bind(this);
        this._onKey    = this._onKey.bind(this);
        this._onDblClick = this._onDblClick.bind(this);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    activate() {
        this.canvas.addEventListener('mousedown',  this._onDown);
        this.canvas.addEventListener('mousemove',  this._onMove);
        this.canvas.addEventListener('mouseup',    this._onUp);
        this.canvas.addEventListener('dblclick',   this._onDblClick);
        window.addEventListener('keydown', this._onKey);
        this.canvas.style.cursor = this._cursorForTool();
        this.draw();
    }

    deactivate() {
        this.canvas.removeEventListener('mousedown',  this._onDown);
        this.canvas.removeEventListener('mousemove',  this._onMove);
        this.canvas.removeEventListener('mouseup',    this._onUp);
        this.canvas.removeEventListener('dblclick',   this._onDblClick);
        window.removeEventListener('keydown', this._onKey);
    }

    setTool(tool) {
        this.tool = tool;
        this._draft      = null;
        this._draftPts   = [];
        this._bezierPts  = [];
        this._bezierMouse = null;
        this._isDown     = false;
        this._marqueeStart = null;
        this._marqueeEnd = null;
        if (tool !== 'select') this._sel = [];
        this.canvas.style.cursor = this._cursorForTool();
        this.draw();
    }

    setStrokeWidth(w) { this.strokeWidth = w; }
    setEraserRadius(r) { this.eraserRadius = r; }

    clearAll() { this.shapes = []; this._sel = []; this.draw(); }

    // ── Coordinate helpers ────────────────────────────────────────────────────

    _canvasToMachine(cx, cy) {
        const { scale, offsetX, offsetY } = this.view;
        // machine.x = (canvas.x - offsetX) / scale
        // machine.y = (offsetY - canvas.y) / scale   [Y is flipped]
        return {
            x: (cx - offsetX) / scale,
            y: (offsetY - cy) / scale
        };
    }

    _machineToCanvas(mx, my) {
        const { scale, offsetX, offsetY } = this.view;
        return {
            x: mx * scale + offsetX,
            y: offsetY - my * scale
        };
    }

    _eventPos(e) {
        const r = this.canvas.getBoundingClientRect();
        return this._canvasToMachine(e.clientX - r.left, e.clientY - r.top);
    }

    _cursorForTool() {
        switch(this.tool) {
            case 'select':  return 'default';
            case 'eraser':  return 'cell';
            case 'pencil':  return 'crosshair';
            default:        return 'crosshair';
        }
    }

    // ── Clamping to bed ───────────────────────────────────────────────────────

    _clamp(mx, my) {
        const { bedW, bedH } = this.view;
        return {
            x: Math.max(0, Math.min(bedW, mx)),
            y: Math.max(0, Math.min(bedH, my))
        };
    }

    // ── Event Handlers ────────────────────────────────────────────────────────

    _onDown(e) {
        const m = this._eventPos(e);
        const mc = this._clamp(m.x, m.y);
        this._isDown = true;

        if (this.tool === 'select') {
            const hit = [...this.shapes].reverse().find(s => hitTest(s, m.x, m.y, 5 / this.view.scale));
            
            if (hit && this._sel.includes(hit.id)) {
                this._dragStart = { mx: m.x, my: m.y };
                this._shapePre = this.shapes.filter(s => this._sel.includes(s.id)).map(s => JSON.parse(JSON.stringify(s)));
            } else if (hit) {
                this._sel = [hit.id];
                this._dragStart = { mx: m.x, my: m.y };
                this._shapePre = [JSON.parse(JSON.stringify(hit))];
            } else {
                this._sel = [];
                this._marqueeStart = { mx: m.x, my: m.y };
                this._marqueeEnd = { ...mc };
            }
            this.draw();
            return;
        }

        if (this.tool === 'eraser') {
            this._eraseAt(m.x, m.y);
            this.draw();
            return;
        }

        if (this.tool === 'pencil') {
            this._draftPts = [mc];
            this._draft = makePencil(this._draftPts, this.strokeWidth);
            return;
        }

        // Bezier – collect up to 4 clicks: start, ctrl1, ctrl2, end
        if (this.tool === 'bezier') {
            this._bezierPts.push(mc);
            if (this._bezierPts.length === 4) {
                const [p0, c1, c2, p1] = this._bezierPts;
                this.shapes.push(makeBezier(p0.x, p0.y, c1.x, c1.y, c2.x, c2.y, p1.x, p1.y, this.strokeWidth));
                this._bezierPts  = [];
                this._bezierMouse = null;
                this._draft = null;
                this.draw();
                this._emitChange();
            }
            return;
        }

        // Line, rect, circle – anchor first point
        this._draftPts = [mc];
    }

    _onMove(e) {
        if (!this._isDown) {
            if (this.tool === 'eraser') this.draw();
            // Bezier live preview after at least one point is placed
            if (this.tool === 'bezier' && this._bezierPts.length > 0) {
                const m = this._eventPos(e);
                this._bezierMouse = this._clamp(m.x, m.y);
                this.draw();
            }
            return;
        }
        const m  = this._eventPos(e);
        const mc = this._clamp(m.x, m.y);

        if (this.tool === 'select') {
            if (this._marqueeStart) {
                this._marqueeEnd = mc;
                this.draw();
            } else if (this._sel.length > 0 && this._dragStart) {
                let dx = m.x - this._dragStart.mx;
                let dy = m.y - this._dragStart.my;
                
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const pre of this._shapePre) {
                    const bb = shapeBBox(pre);
                    minX = Math.min(minX, bb.x);
                    minY = Math.min(minY, bb.y);
                    maxX = Math.max(maxX, bb.x + bb.w);
                    maxY = Math.max(maxY, bb.y + bb.h);
                }
                
                if (minX + dx < 0) dx = -minX;
                if (maxX + dx > this.view.bedW) dx = this.view.bedW - maxX;
                if (minY + dy < 0) dy = -minY;
                if (maxY + dy > this.view.bedH) dy = this.view.bedH - maxY;

                for (const shape of this.shapes) {
                    if (this._sel.includes(shape.id)) {
                        const pre = this._shapePre.find(p => p.id === shape.id);
                        if (pre) {
                            Object.assign(shape, JSON.parse(JSON.stringify(pre)));
                            translateShape(shape, dx, dy);
                        }
                    }
                }
                this.draw();
            }
            return;
        }

        if (this.tool === 'eraser') {
            this._eraseAt(m.x, m.y);
            this.draw();
            return;
        }

        if (this.tool === 'pencil') {
            this._draftPts.push(mc);
            this._draft = makePencil(this._draftPts, this.strokeWidth);
            this.draw();
            return;
        }

        if (this._draftPts.length > 0) {
            const [a] = this._draftPts;
            const b   = mc;
            if (this.tool === 'line') {
                this._draft = makeLine(a.x, a.y, b.x, b.y, this.strokeWidth);
            } else if (this.tool === 'rect') {
                let w = Math.abs(b.x - a.x);
                let h = Math.abs(b.y - a.y);
                if (e.shiftKey) {
                    const size = Math.max(w, h);
                    w = size;
                    h = size;
                }
                const rx = b.x < a.x ? Math.max(0, a.x - w) : a.x;
                const ry = b.y < a.y ? Math.max(0, a.y - h) : a.y;
                w = b.x < a.x ? a.x - rx : Math.min(this.view.bedW - rx, w);
                h = b.y < a.y ? a.y - ry : Math.min(this.view.bedH - ry, h);
                this._draft = makeRect(rx, ry, w, h, this.strokeWidth);
            } else if (this.tool === 'circle') {
                let rx = Math.abs(b.x - a.x);
                let ry = Math.abs(b.y - a.y);
                if (e.shiftKey) {
                    const size = Math.max(rx, ry);
                    rx = size;
                    ry = size;
                }
                rx = Math.min(rx, Math.min(a.x, this.view.bedW - a.x));
                ry = Math.min(ry, Math.min(a.y, this.view.bedH - a.y));
                this._draft = makeCircle(
                    a.x, a.y, rx, ry, this.strokeWidth
                );
            }
            this.draw();
        }
    }

    _onUp(e) {
        if (!this._isDown) return;
        this._isDown = false;

        if (this.tool === 'select') {
            if (this._marqueeStart && this._marqueeEnd) {
                const xmin = Math.min(this._marqueeStart.mx, this._marqueeEnd.x);
                const xmax = Math.max(this._marqueeStart.mx, this._marqueeEnd.x);
                const ymin = Math.min(this._marqueeStart.my, this._marqueeEnd.y);
                const ymax = Math.max(this._marqueeStart.my, this._marqueeEnd.y);
                
                this._sel = this.shapes.filter(s => {
                    const bb = shapeBBox(s);
                    return !(bb.x > xmax || bb.x + bb.w < xmin || bb.y > ymax || bb.y + bb.h < ymin);
                }).map(s => s.id);
            }
            this._dragStart = null;
            this._shapePre  = null;
            this._marqueeStart = null;
            this._marqueeEnd = null;
            this.draw();
            return;
        }

        if (this.tool === 'eraser' || this.tool === 'select') return;

        if (this._draft) {
            // Only commit if shape has some extent
            const bbox = shapeBBox(this._draft);
            const minExtent = 0.5; // mm
            if (bbox.w > minExtent || bbox.h > minExtent || this._draft.type === 'pencil' && this._draftPts.length > 2) {
                this.shapes.push(this._draft);
            }
        }

        this._draft    = null;
        this._draftPts = [];
        this.draw();

        // Notify external listener so G-code can be regenerated
        this._emitChange();
    }

    _onDblClick() {
        // Double-click deselects
        this._sel = [];
        this.draw();
    }

    _onKey(e) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this._sel.length > 0 && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
                this.shapes = this.shapes.filter(s => !this._sel.includes(s.id));
                this._sel = [];
                this.draw();
                this._emitChange();
            }
        }
        if (e.key === 'Escape') {
            this._sel        = [];
            this._draft      = null;
            this._bezierPts  = [];
            this._bezierMouse = null;
            this._isDown     = false;
            this._marqueeStart = null;
            this._marqueeEnd = null;
            this.draw();
        }
    }

    _eraseAt(mx, my) {
        const tol = this.eraserRadius;
        this.shapes = this.shapes.filter(s => !hitTest(s, mx, my, tol / this.view.scale));
        this._sel = this._sel.filter(id => this.shapes.some(s => s.id === id));
        this._emitChange();
    }

    // ── Render ────────────────────────────────────────────────────────────────

    draw() {
        const ctx = this.ctx;
        const { scale, offsetX, offsetY, bedW, bedH } = this.view;
        const mapX = x => x * scale + offsetX;
        const mapY = y => offsetY - y * scale;

        // Clear entire canvas
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // ── Bed background ──────────────────────────────────────────────────
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(mapX(0), mapY(bedH), bedW * scale, bedH * scale);

        // Subtle grid — every 50mm
        ctx.strokeStyle = 'rgba(203,213,225,0.4)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        for (let gx = 0; gx <= bedW; gx += 50) {
            ctx.beginPath();
            ctx.moveTo(mapX(gx), mapY(0));
            ctx.lineTo(mapX(gx), mapY(bedH));
            ctx.stroke();
        }
        for (let gy = 0; gy <= bedH; gy += 50) {
            ctx.beginPath();
            ctx.moveTo(mapX(0), mapY(gy));
            ctx.lineTo(mapX(bedW), mapY(gy));
            ctx.stroke();
        }

        // Bed border
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(mapX(0), mapY(bedH), bedW * scale, bedH * scale);
        ctx.setLineDash([]);

        // Corner labels
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px ui-monospace';
        ctx.textAlign = 'left';
        ctx.fillText('0,0 (BL)', mapX(0) + 4, mapY(0) - 4);
        ctx.textAlign = 'right';
        ctx.fillText(`${bedW}×${bedH}mm`, mapX(bedW) - 4, mapY(bedH) + 12);
        ctx.restore();

        // ── Shapes ──────────────────────────────────────────────────────────
        // Save state and clip to the bed boundaries so shapes don't visually overflow
        ctx.save();
        ctx.beginPath();
        ctx.rect(mapX(0), mapY(bedH), bedW * scale, bedH * scale);
        ctx.clip();

        for (const shape of this.shapes) {
            this._drawShape(ctx, shape, mapX, mapY, scale, this._sel.includes(shape.id));
        }

        // Draft (being drawn right now)
        if (this._draft) {
            this._drawShape(ctx, this._draft, mapX, mapY, scale, false, true);
        }
        
        // Marquee Selection Box
        if (this._marqueeStart && this._marqueeEnd) {
            ctx.save();
            ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            const x = Math.min(this._marqueeStart.mx, this._marqueeEnd.x);
            const y = Math.min(this._marqueeStart.my, this._marqueeEnd.y);
            const w = Math.abs(this._marqueeStart.mx - this._marqueeEnd.x);
            const h = Math.abs(this._marqueeStart.my - this._marqueeEnd.y);
            ctx.fillRect(mapX(x), mapY(y+h), w*scale, h*scale);
            ctx.strokeRect(mapX(x), mapY(y+h), w*scale, h*scale);
            ctx.restore();
        }

        // Bezier in-progress: draw placed points + live preview segment
        if (this.tool === 'bezier' && this._bezierPts.length > 0) {
            const pts = [...this._bezierPts];
            const mouse = this._bezierMouse;
            const labels = ['Start', 'Ctrl 1', 'Ctrl 2', 'End'];

            // Draw placed anchor/control dots
            ctx.save();
            ctx.fillStyle = '#60a5fa';
            ctx.strokeStyle = 'rgba(96,165,250,0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3,3]);
            for (let i = 0; i < pts.length; i++) {
                // Connect adjacent placed points with a guide line
                if (i > 0) {
                    ctx.beginPath();
                    ctx.moveTo(mapX(pts[i-1].x), mapY(pts[i-1].y));
                    ctx.lineTo(mapX(pts[i].x), mapY(pts[i].y));
                    ctx.stroke();
                }
                ctx.beginPath();
                ctx.arc(mapX(pts[i].x), mapY(pts[i].y), 5, 0, 2*Math.PI);
                ctx.fill();
                ctx.fillStyle = '#94a3b8';
                ctx.font = '9px ui-monospace';
                ctx.textAlign = 'left';
                ctx.fillText(labels[i], mapX(pts[i].x) + 8, mapY(pts[i].y) - 4);
                ctx.fillStyle = '#60a5fa';
            }

            // Live guide line from last point to mouse
            if (mouse) {
                ctx.beginPath();
                ctx.moveTo(mapX(pts[pts.length-1].x), mapY(pts[pts.length-1].y));
                ctx.lineTo(mapX(mouse.x), mapY(mouse.y));
                ctx.stroke();

                // Show live bezier preview once we have start+ctrl1+ctrl2
                if (pts.length === 3) {
                    ctx.setLineDash([]);
                    ctx.strokeStyle = 'rgba(59,130,246,0.75)';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(mapX(pts[0].x), mapY(pts[0].y));
                    ctx.bezierCurveTo(
                        mapX(pts[1].x), mapY(pts[1].y),
                        mapX(pts[2].x), mapY(pts[2].y),
                        mapX(mouse.x),  mapY(mouse.y)
                    );
                    ctx.stroke();
                }
            }
            ctx.restore();

            // Instruction hint
            ctx.save();
            ctx.fillStyle = '#64748b';
            ctx.font = '11px ui-monospace';
            ctx.textAlign = 'center';
            const hints = ['Click to set Start','Click to set Control 1','Click to set Control 2','Click to set End'];
            ctx.fillText(hints[pts.length] || '', mapX(this.view.bedW / 2), mapY(this.view.bedH) + 22);
            ctx.restore();
        }
        
        ctx.restore(); // Restore from bed boundaries clipping
    }

    _drawShape(ctx, shape, mapX, mapY, scale, selected, isDraft) {
        ctx.save();

        // Stroke width in canvas pixels (keep it at least 1px)
        const pxW = Math.max(1, shape.strokeWidth * scale);

        ctx.lineWidth   = pxW;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.setLineDash([]);

        if (isDraft) {
            ctx.strokeStyle = 'rgba(59,130,246,0.7)'; // accent blue
            ctx.setLineDash([4, 4]);
        } else if (selected) {
            ctx.strokeStyle = '#10b981'; // emerald selected
        } else {
            ctx.strokeStyle = '#f97316'; // orange, same as trajectory dots
        }

        ctx.beginPath();

        switch (shape.type) {
            case 'pencil': {
                if (shape.points.length < 2) break;
                const [p0, ...rest] = shape.points;
                ctx.moveTo(mapX(p0.x), mapY(p0.y));
                rest.forEach(p => ctx.lineTo(mapX(p.x), mapY(p.y)));
                break;
            }
            case 'line': {
                ctx.moveTo(mapX(shape.x1), mapY(shape.y1));
                ctx.lineTo(mapX(shape.x2), mapY(shape.y2));
                break;
            }
            case 'rect': {
                const { x, y, w, h } = shape;
                ctx.rect(mapX(x), mapY(y + h), w * scale, h * scale);
                break;
            }
            case 'circle': {
                const { cx, cy, rx, ry } = shape;
                ctx.ellipse(mapX(cx), mapY(cy), rx * scale, ry * scale, 0, 0, 2 * Math.PI);
                break;
            }
            case 'bezier': {
                const { x1, y1, cx1, cy1, cx2, cy2, x2, y2 } = shape;
                ctx.moveTo(mapX(x1), mapY(y1));
                ctx.bezierCurveTo(mapX(cx1), mapY(cy1), mapX(cx2), mapY(cy2), mapX(x2), mapY(y2));
                break;
            }
        }

        ctx.stroke();

        // For bezier: draw control handle lines when selected or in draft
        if (shape.type === 'bezier' && (selected || isDraft)) {
            const { x1, y1, cx1, cy1, cx2, cy2, x2, y2 } = shape;
            ctx.save();
            ctx.strokeStyle = 'rgba(96,165,250,0.6)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(mapX(x1),  mapY(y1));
            ctx.lineTo(mapX(cx1), mapY(cy1));
            ctx.moveTo(mapX(x2),  mapY(y2));
            ctx.lineTo(mapX(cx2), mapY(cy2));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#60a5fa';
            for (const [hx, hy] of [[cx1,cy1],[cx2,cy2]]) {
                ctx.beginPath();
                ctx.arc(mapX(hx), mapY(hy), 4, 0, 2 * Math.PI);
                ctx.fill();
            }
            ctx.restore();
        }

        // Selection bounding box handles
        if (selected) {
            const bbox = shapeBBox(shape);
            const bx = mapX(bbox.x);
            const by = mapY(bbox.y + bbox.h);
            const bw = bbox.w * scale;
            const bh = bbox.h * scale;
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(bx - 4, by - 4, bw + 8, bh + 8);
            ctx.fillStyle = '#10b981';
            ctx.setLineDash([]);
            for (const [hx, hy] of [[bx-4,by-4],[bx+bw+4,by-4],[bx-4,by+bh+4],[bx+bw+4,by+bh+4]]) {
                ctx.beginPath();
                ctx.arc(hx, hy, 4, 0, 2 * Math.PI);
                ctx.fill();
            }
        }

        ctx.restore();
    }

    // ── Export ────────────────────────────────────────────────────────────────

    exportAsSVG() {
        const { bedW, bedH } = this.view;
        const paths = this.shapes
            .map(s => shapeToPathD(s, bedH))
            .filter(d => d.length > 0)
            .map(d => `  <path d="${d}" />`)
            .join('\n');

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bedW} ${bedH}" width="${bedW}mm" height="${bedH}mm" data-source="canvas">
<style>path { fill: none; stroke: #000; stroke-width: 1px; }</style>
${paths}
</svg>`;
    }

    importSVG(svgText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        
        // We need to un-flip the Y axis since exportAsSVG flips it.
        const { bedH } = this.view;
        const fy = y => (bedH - y);

        const paths = doc.querySelectorAll('path');
        paths.forEach(p => {
            const d = p.getAttribute('d');
            if (!d) return;
            const strokeWidth = parseFloat(p.getAttribute('stroke-width')) || 1.5;
            
            // Very naive parser for paths
            if (d.includes('C') || d.includes('c')) {
                // Bezier: M x1 y1 C cx1 cy1 cx2 cy2 x2 y2
                const match = d.match(/M\s+([-\d.]+)\s+([-\d.]+)\s+C\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i);
                if (match) {
                    this.shapes.push(makeBezier(
                        parseFloat(match[1]), fy(parseFloat(match[2])),
                        parseFloat(match[3]), fy(parseFloat(match[4])),
                        parseFloat(match[5]), fy(parseFloat(match[6])),
                        parseFloat(match[7]), fy(parseFloat(match[8])),
                        strokeWidth
                    ));
                }
            } else {
                // Pencil / Line / Rect / Circle approximations
                const points = [];
                const regex = /[ML]\s+([-\d.]+)\s+([-\d.]+)/gi;
                let match;
                while ((match = regex.exec(d)) !== null) {
                    points.push({ x: parseFloat(match[1]), y: fy(parseFloat(match[2])) });
                }
                if (points.length === 2) {
                    this.shapes.push(makeLine(points[0].x, points[0].y, points[1].x, points[1].y, strokeWidth));
                } else if (points.length > 2) {
                    this.shapes.push(makePencil(points, strokeWidth));
                }
            }
        });

        const rects = doc.querySelectorAll('rect');
        rects.forEach(r => {
            const x = parseFloat(r.getAttribute('x')||0);
            const y = parseFloat(r.getAttribute('y')||0);
            const w = parseFloat(r.getAttribute('width')||0);
            const h = parseFloat(r.getAttribute('height')||0);
            this.shapes.push(makeRect(x, fy(y+h), w, h, 1.5));
        });

        const circles = doc.querySelectorAll('circle');
        circles.forEach(c => {
            const cx = parseFloat(c.getAttribute('cx')||0);
            const cy = parseFloat(c.getAttribute('cy')||0);
            const r = parseFloat(c.getAttribute('r')||0);
            this.shapes.push(makeCircle(cx, fy(cy), r, r, 1.5));
        });
        
        const ellipses = doc.querySelectorAll('ellipse');
        ellipses.forEach(c => {
            const cx = parseFloat(c.getAttribute('cx')||0);
            const cy = parseFloat(c.getAttribute('cy')||0);
            const rx = parseFloat(c.getAttribute('rx')||0);
            const ry = parseFloat(c.getAttribute('ry')||0);
            this.shapes.push(makeCircle(cx, fy(cy), rx, ry, 1.5));
        });

        const lines = doc.querySelectorAll('line');
        lines.forEach(l => {
            const x1 = parseFloat(l.getAttribute('x1')||0);
            const y1 = parseFloat(l.getAttribute('y1')||0);
            const x2 = parseFloat(l.getAttribute('x2')||0);
            const y2 = parseFloat(l.getAttribute('y2')||0);
            this.shapes.push(makeLine(x1, fy(y1), x2, fy(y2), 1.5));
        });
        
        const polylines = doc.querySelectorAll('polyline, polygon');
        polylines.forEach(p => {
            const ptsStr = p.getAttribute('points') || '';
            const coords = ptsStr.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
            const points = [];
            for(let i=0; i<coords.length; i+=2) {
                if (i+1 < coords.length) points.push({x: coords[i], y: fy(coords[i+1])});
            }
            if (p.tagName.toLowerCase() === 'polygon' && points.length > 0) {
                points.push({...points[0]});
            }
            if (points.length === 2) {
                this.shapes.push(makeLine(points[0].x, points[0].y, points[1].x, points[1].y, 1.5));
            } else if (points.length > 2) {
                this.shapes.push(makePencil(points, 1.5));
            }
        });

        this.draw();
        this._emitChange();
    }

    get hasShapes() { return this.shapes.length > 0; }

    // ── Internal event bus ────────────────────────────────────────────────────

    _emitChange() {
        this.canvas.dispatchEvent(new CustomEvent('editor:changed', { bubbles: true }));
    }
}
