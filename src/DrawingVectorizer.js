/**
 * DrawingVectorizer — hand-drawing photo → color-grouped vector paths.
 *
 * Substrate-agnostic (any paper size/color/material) and palette-agnostic
 * (discovers however many pen colors are actually present). Pipeline:
 *   1. Substrate color estimate (border ring median, Lab).
 *   2. Ink mask = pixels far from substrate in CIE Lab ΔE.
 *   3. Adaptive color clustering (k-means++ in Lab, merge near-duplicates by ΔE).
 *   4. Per color: skeletonize (TraceSkeleton) → centerline polylines.
 *   5. Simplify (RDP) + smooth (Catmull-Rom → Bézier).
 * Returns detected colors; caller maps each color → machine operation and
 * builds an SVG (buildSVG) fed to CanvasEditor.importSVG.
 *
 * Runs on a downscaled working raster (<= MAX_EDGE) for speed; coordinates are
 * carried in working-pixel space and mapped to mm via the SVG viewBox.
 */

const MAX_EDGE = 1400;      // working raster cap — plenty for clean skeletons
const K_INIT = 6;           // initial cluster count (over-cluster, then merge)
const MERGE_DE = 14;        // centroids closer than this ΔE collapse into one color
const MIN_CLUSTER_FRAC = 0.004; // drop clusters below this fraction of ink pixels

// ── color space ──────────────────────────────────────────────────────────
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab(r, g, b) {
    const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a, b) { const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2]; return Math.sqrt(dl * dl + da * da + db * db); }

// ── display names (cosmetic only — masking always uses measured color) ─────
const NAMED = [
    ['black', 20, 20, 20], ['white', 245, 245, 245], ['gray', 130, 130, 130],
    ['red', 220, 40, 40], ['orange', 240, 140, 30], ['yellow', 240, 220, 40],
    ['green', 40, 170, 70], ['teal', 30, 170, 160], ['blue', 40, 90, 210],
    ['purple', 140, 60, 190], ['pink', 235, 100, 170], ['brown', 140, 90, 50],
];
const NAMED_LAB = NAMED.map(n => ({ name: n[0], lab: rgbToLab(n[1], n[2], n[3]) }));
function nearestName(lab) {
    let best = Infinity, name = 'ink';
    for (const c of NAMED_LAB) { const d = deltaE(lab, c.lab); if (d < best) { best = d; name = c.name; } }
    return name;
}

// ── geometry: dedupe + RDP simplify + Catmull-Rom smoothing ────────────────
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function dedupe(pts, minSeg = 1.1) {
    if (pts.length <= 1) return pts.slice();
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (dist(out[out.length - 1], pts[i]) >= minSeg) out.push(pts[i]);
    if (out.length === 1 && pts.length > 1) out.push(pts[pts.length - 1]);
    return out;
}
function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return dist(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function rdp(pts, eps) {
    if (pts.length <= 2) return pts.slice();
    let dmax = 0, idx = -1;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax <= eps || idx === -1) return [a, b];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}
function simplify(poly) {
    const pts = dedupe(poly.map(([x, y]) => ({ x, y })));
    if (pts.length <= 2) return pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    const eps = Math.max(0.8, Math.min(4, diag * 0.01 + pts.length * 0.004));
    const s = rdp(pts, eps);
    return s.length < 2 ? pts : s;
}
function num(v) { return Number(v.toFixed(2)); }
// Catmull-Rom → cubic Bézier smoothing. The canvas importer now tessellates
// curves, so compact C-segments render smoothly and stay small.
function toPathD(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return `M ${num(pts[0].x)},${num(pts[0].y)}`;
    if (pts.length === 2) return `M ${num(pts[0].x)},${num(pts[0].y)} L ${num(pts[1].x)},${num(pts[1].y)}`;
    const T = 0.85;
    let d = `M ${num(pts[0].x)},${num(pts[0].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const c1 = { x: p1.x + ((p2.x - p0.x) * T) / 6, y: p1.y + ((p2.y - p0.y) * T) / 6 };
        const c2 = { x: p2.x - ((p3.x - p1.x) * T) / 6, y: p2.y - ((p3.y - p1.y) * T) / 6 };
        d += ` C ${num(c1.x)},${num(c1.y)} ${num(c2.x)},${num(c2.y)} ${num(p2.x)},${num(p2.y)}`;
    }
    return d;
}

// ── k-means++ over Lab samples ─────────────────────────────────────────────
function kmeans(samples, k, iters = 12) {
    if (samples.length <= k) return samples.map(s => s.slice());
    // k-means++ seeding
    const cents = [samples[(Math.random() * samples.length) | 0].slice()];
    while (cents.length < k) {
        const d2 = samples.map(s => { let m = Infinity; for (const c of cents) m = Math.min(m, deltaE(s, c) ** 2); return m; });
        let sum = d2.reduce((a, b) => a + b, 0), r = Math.random() * sum, i = 0;
        while (r > d2[i] && i < d2.length - 1) { r -= d2[i]; i++; }
        cents.push(samples[i].slice());
    }
    for (let it = 0; it < iters; it++) {
        const acc = cents.map(() => [0, 0, 0, 0]);
        for (const s of samples) {
            let bi = 0, bd = Infinity;
            for (let c = 0; c < cents.length; c++) { const d = deltaE(s, cents[c]); if (d < bd) { bd = d; bi = c; } }
            const a = acc[bi]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++;
        }
        for (let c = 0; c < cents.length; c++) if (acc[c][3] > 0) cents[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    }
    return cents;
}
function mergeCentroids(cents, de) {
    const out = [];
    for (const c of cents) {
        const hit = out.find(o => deltaE(o, c) < de);
        if (!hit) out.push(c.slice());
    }
    return out;
}

// ── main analysis ──────────────────────────────────────────────────────────
// sourceCanvas: the flattened page raster. paperW/paperH: mm dimensions.
// opts.inkThreshold: ΔE from substrate to count as ink (default adaptive).
// Returns { w, h, paperW, paperH, colors: [{ rgb, name, count, paths:[d…] }] }.
export function analyzeDrawing(sourceCanvas, paperW, paperH, opts = {}) {
    if (!window.TraceSkeleton) throw new Error('TraceSkeleton library not loaded');

    // 1. downscale to working raster
    const sw = sourceCanvas.width, sh = sourceCanvas.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const work = document.createElement('canvas'); work.width = w; work.height = h;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(sourceCanvas, 0, 0, w, h);
    const data = wctx.getImageData(0, 0, w, h).data;
    const N = w * h;

    // precompute Lab per pixel
    const lab = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const j = i * 4, l = rgbToLab(data[j], data[j + 1], data[j + 2]);
        lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2];
    }

    // 2. substrate estimate — median Lab of an outer border ring
    const ring = [];
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x < bw || x >= w - bw || y < bw || y >= h - bw) {
            const i = y * w + x; ring.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
        }
    }
    const med = axis => { const v = ring.map(p => p[axis]).sort((a, b) => a - b); return v[v.length >> 1]; };
    const bg = [med(0), med(1), med(2)];

    // 3. ink mask + samples
    const inkThresh = opts.inkThreshold || 16;
    const inkIdx = [];
    for (let i = 0; i < N; i++) {
        const d = deltaE([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], bg);
        if (d > inkThresh) inkIdx.push(i);
    }
    if (!inkIdx.length) return { w, h, paperW, paperH, colors: [] };

    // subsample for clustering
    const cap = 30000;
    const step = Math.max(1, Math.floor(inkIdx.length / cap));
    const samples = [];
    for (let s = 0; s < inkIdx.length; s += step) { const i = inkIdx[s]; samples.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }

    let cents = mergeCentroids(kmeans(samples, K_INIT), MERGE_DE);

    // 4. assign every ink pixel to nearest centroid; count
    const counts = new Array(cents.length).fill(0);
    const assign = new Int32Array(N).fill(-1);
    for (const i of inkIdx) {
        let bi = 0, bd = Infinity;
        const pl = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
        for (let c = 0; c < cents.length; c++) { const d = deltaE(pl, cents[c]); if (d < bd) { bd = d; bi = c; } }
        assign[i] = bi; counts[bi]++;
    }
    // drop tiny clusters
    const minCount = inkIdx.length * MIN_CLUSTER_FRAC;
    const keep = cents.map((_, c) => counts[c] >= minCount);

    // representative RGB per kept cluster = CHROMA-WEIGHTED mean of member pixels.
    // Anti-aliased stroke edges blend toward the paper and would desaturate a plain
    // mean; weighting by saturation pulls the swatch toward the vivid stroke core.
    const rgbAcc = cents.map(() => [0, 0, 0, 0]);
    for (const i of inkIdx) {
        const c = assign[i]; if (!keep[c]) continue;
        const j = i * 4, r = data[j], g = data[j + 1], b = data[j + 2];
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        const wgt = chroma * chroma + 0.04; // floor keeps neutral (black/gray) inks working
        const a = rgbAcc[c]; a[0] += r * wgt; a[1] += g * wgt; a[2] += b * wgt; a[3] += wgt;
    }

    // 5. per kept cluster: skeletonize → polylines → simplify
    const colors = [];
    for (let c = 0; c < cents.length; c++) {
        if (!keep[c] || rgbAcc[c][3] === 0) continue;
        const rgb = [Math.round(rgbAcc[c][0] / rgbAcc[c][3]), Math.round(rgbAcc[c][1] / rgbAcc[c][3]), Math.round(rgbAcc[c][2] / rgbAcc[c][3])];

        // white-on-black mask canvas for this cluster
        const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
        const mx = mc.getContext('2d');
        const md = mx.createImageData(w, h);
        for (let i = 0; i < N; i++) {
            const on = assign[i] === c ? 255 : 0;
            const j = i * 4; md.data[j] = on; md.data[j + 1] = on; md.data[j + 2] = on; md.data[j + 3] = 255;
        }
        mx.putImageData(md, 0, 0);

        const res = window.TraceSkeleton.fromCanvas(mc);
        const paths = [];
        for (const poly of (res.polylines || [])) {
            if (poly.length < 6) continue; // drop specks
            const s = simplify(poly);
            if (s.length < 2) continue;
            paths.push(toPathD(s));
        }
        if (!paths.length) continue;
        const labC = rgbToLab(rgb[0], rgb[1], rgb[2]);
        colors.push({ rgb, name: nearestName(labC), count: counts[c], paths });
    }

    // sort by prominence
    colors.sort((a, b) => b.count - a.count);
    return { w, h, paperW, paperH, colors };
}

// Build an SVG from color→method assignments. `assignments` maps color index
// (into result.colors) → method ('thru_cut'|'off_base'|'crease'|'draw'|'ignore').
export function buildSVG(result, assignments) {
    const { w, h, paperW, paperH, colors } = result;
    let body = '';
    colors.forEach((col, i) => {
        const method = assignments[i];
        if (!method || method === 'ignore') return;
        // Stroke = the ORIGINAL ink color so the canvas visually matches the drawing
        // (blue cat, red box, green cross) for validation; data-method carries the
        // machine operation for Create Path. 'draw' has no cut geometry downstream,
        // so it is tagged thru_cut but kept distinct via data-op.
        const [r, g, b] = col.rgb;
        const dm = method === 'draw' ? 'thru_cut' : method;
        body += `  <path d="${col.paths.join(' ')}" fill="none" stroke="rgb(${r},${g},${b})" stroke-width="0.5" vector-effect="non-scaling-stroke" data-method="${dm}" data-op="${method}"/>\n`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${paperW}mm" height="${paperH}mm">\n${body}</svg>`;
}
