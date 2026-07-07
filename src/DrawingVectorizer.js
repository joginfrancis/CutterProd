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
// Colors are merged by HUE (lightness-invariant): a marker's solid core and its
// anti-aliased edge share a hue and collapse; distinct pens keep their hue and stay
// separate — reliable even on dim/low-saturation photos.
const HUE_MERGE_RAD = 32 * Math.PI / 180; // same-hue shades within ~32° merge
const CHROMA_MIN = 7;                      // Lab chroma below this = neutral (black/gray)
const MIN_CLUSTER_FRAC = 0.01;             // drop clusters below this fraction of ink pixels (spurs)

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
// Named by HUE, not nearest-swatch ΔE: photographed ink is dimmer/desaturated
// than a reference swatch, so ΔE matching mislabels (dull orange → "brown",
// pale green → "gray"). Hue survives desaturation, so it names correctly.
function nearestName(lab) {
    const [L, a, b] = lab;
    const chroma = Math.hypot(a, b);
    if (chroma < 10) return L < 30 ? 'black' : L > 80 ? 'white' : 'gray';
    let h = Math.atan2(b, a) * 180 / Math.PI; if (h < 0) h += 360;
    if (h < 45 || h >= 335) return (L > 62 && chroma < 60) ? 'pink' : 'red';
    if (h < 80)  return L < 40 ? 'brown' : 'orange';
    if (h < 115) return 'yellow';
    if (h < 160) return 'green';
    if (h < 215) return 'teal';
    if (h < 300) return 'blue';
    return 'purple';
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
// epsScale: multiplies the adaptive RDP epsilon (higher = coarser/simpler).
function simplify(poly, epsScale = 1) {
    const pts = dedupe(poly.map(([x, y]) => ({ x, y })));
    if (pts.length <= 2) return pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    const eps = Math.max(0.4, (diag * 0.01 + pts.length * 0.004) * epsScale);
    const s = rdp(pts, eps);
    return s.length < 2 ? pts : s;
}
function num(v) { return Number(v.toFixed(2)); }
// Straightness at vertex b between a→b and b→c: 1 when collinear, 0 at a ≥90° turn.
// Used to suppress smoothing across sharp corners so they stay crisp.
function straightness(a, b, c) {
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) return 1;
    return Math.max(0, (ux * vx + uy * vy) / (lu * lv));
}
// Corner-aware Catmull-Rom → cubic Bézier. Handles are (a) scaled by local
// straightness so sharp corners stay sharp, and (b) length-capped to 1/3 of the
// segment so gentle curves can never overshoot/balloon outward. The canvas importer
// tessellates the resulting C-segments back to points for editing/CAM.
// tension (0..~1): smoothing strength. 0 → straight polyline (accurate), higher → rounder.
// cornerSharp (0..1): raises the straightness weighting exponent, shrinking handles
// harder at bends — knife/crease corners come out crisp instead of rounded.
// closed: treat pts as a loop — wrap-around tangents + 'Z' so the machine sees one
// continuous closed contour (no uncut tab / seam at the join).
function toPathD(pts, tension = 0.9, cornerSharp = 0, closed = false) {
    if (!pts.length) return '';
    if (pts.length === 1) return `M ${num(pts[0].x)},${num(pts[0].y)}`;
    if (pts.length === 2) return `M ${num(pts[0].x)},${num(pts[0].y)} L ${num(pts[1].x)},${num(pts[1].y)}`;
    const T = tension;
    const exp = 1 + cornerSharp * 4;   // 0 → current behaviour, 1 → very crisp corners
    const sharp = (a, b, c) => Math.pow(straightness(a, b, c), exp);
    const cap = (hx, hy, max) => { const l = Math.hypot(hx, hy); return l > max && l > 0 ? [hx * max / l, hy * max / l] : [hx, hy]; };
    const n = pts.length;
    const at = (i) => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
    let d = `M ${num(pts[0].x)},${num(pts[0].y)}`;
    const segsN = closed ? n : n - 1;   // closed: extra segment back to the start
    for (let i = 0; i < segsN; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const s1 = sharp(p0, p1, p2), s2 = sharp(p1, p2, p3);
        const seg = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        let [h1x, h1y] = cap((p2.x - p0.x) * T / 6 * s1, (p2.y - p0.y) * T / 6 * s1, seg / 3);
        let [h2x, h2y] = cap((p3.x - p1.x) * T / 6 * s2, (p3.y - p1.y) * T / 6 * s2, seg / 3);
        const c1 = { x: p1.x + h1x, y: p1.y + h1y };
        const c2 = { x: p2.x - h2x, y: p2.y - h2y };
        d += ` C ${num(c1.x)},${num(c1.y)} ${num(c2.x)},${num(c2.y)} ${num(p2.x)},${num(p2.y)}`;
    }
    if (closed) d += ' Z';
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
// Hue-based merge: lightness-invariant so a marker's solid core and its anti-aliased
// edge (same hue, different lightness/chroma) collapse into one color, while distinct
// pens (different hue) stay separate — robust even under dim/low-saturation lighting.
function hueOf(lab) { return Math.atan2(lab[2], lab[1]); }      // radians
function chromaOf(lab) { return Math.hypot(lab[1], lab[2]); }
function angDiff(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }
function mergeCentroids(cents, hueTolRad, cMin) {
    const out = [];
    for (const c of cents) {
        const cc = chromaOf(c), ch = hueOf(c);
        const hit = out.find(o => {
            const oc = chromaOf(o), oh = hueOf(o);
            if (cc < cMin && oc < cMin) return true;       // both near-neutral (black/gray) → one bucket
            if (cc < cMin || oc < cMin) return false;      // one neutral, one chromatic → keep apart
            // Both chromatic → merge same-hue shades (an ink's core + antialias fringe
            // share hue but differ a lot in L/chroma, so hue is the only safe test here).
            // Distinct-but-close hues (green ~145° vs teal ~174°) are separated by
            // keeping the tolerance below their gap — user-tunable via Colour separation.
            return angDiff(ch, oh) < hueTolRad;
        });
        if (!hit) out.push(c.slice());
    }
    return out;
}

// Estimate the substrate/paper colour (median of an outer border ring). Returns
// { rgb, working:{w,h} } — used by the wizard's "confirm background" step.
export function estimateSubstrate(sourceCanvas) {
    const sw = sourceCanvas.width, sh = sourceCanvas.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const work = document.createElement('canvas'); work.width = w; work.height = h;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(sourceCanvas, 0, 0, w, h);
    const data = wctx.getImageData(0, 0, w, h).data;
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const rs = [], gs = [], bs = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x < bw || x >= w - bw || y < bw || y >= h - bw) { const j = (y * w + x) * 4; rs.push(data[j]); gs.push(data[j + 1]); bs.push(data[j + 2]); }
    }
    const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    return { rgb: [med(rs), med(gs), med(bs)], working: { w, h } };
}

// Walk an endpoint outward along its tangent until it leaves the ink mask (recovers
// the ~½ stroke-width the medial axis retracts). mask: Uint8Array (w*h), 1 = ink.
function extendEnd(end, prev, mask, w, h, maxExt) {
    let dx = end.x - prev.x, dy = end.y - prev.y;
    const l = Math.hypot(dx, dy); if (l < 1e-3) return end;
    dx /= l; dy /= l;
    let best = end;
    for (let s = 1; s <= maxExt; s++) {
        const x = end.x + dx * s, y = end.y + dy * s;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h || !mask[yi * w + xi]) break;
        best = { x, y };
    }
    return best;
}

// ── binary morphology (separable box) — clean thick/hollow ink bands ─────────
function _dilate(mask, w, h, r) {
    const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) { let on = 0; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && mask[row + xx]) { on = 1; break; } } tmp[row + x] = on; } }
    for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) { let on = 0; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h && tmp[yy * w + x]) { on = 1; break; } } out[row + x] = on; } }
    return out;
}
function _erode(mask, w, h, r) {
    const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) { let on = 1; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= w || !mask[row + xx]) { on = 0; break; } } tmp[row + x] = on; } }
    for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) { let on = 1; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h || !tmp[yy * w + x]) { on = 0; break; } } out[row + x] = on; } }
    return out;
}
// Morphological close (fill hollow/streaky stroke cores) so thinning yields ONE
// centerline per stroke instead of a doubled "ladder" along a thick band.
function _closeMask(mask, w, h, r) { return _erode(_dilate(mask, w, h, r), w, h, r); }

// Stroke half-width estimate via a two-pass chamfer distance transform: the
// 90th-percentile distance of ink pixels to the background ≈ half the pen's
// drawn thickness. Drives an ADAPTIVE close radius — a thick marker needs a
// large close to weld its hollow core (else doubled traces), while fine
// handwriting needs a tiny one (else letters blob together).
function _strokeHalfWidth(mask, w, h) {
    const N = w * h, INF = 1e7;
    const d = new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = mask[i] ? INF : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (!d[i]) continue; let m = d[i];
        if (x > 0) m = Math.min(m, d[i - 1] + 1);
        if (y > 0) {
            m = Math.min(m, d[i - w] + 1);
            if (x > 0) m = Math.min(m, d[i - w - 1] + 1.414);
            if (x < w - 1) m = Math.min(m, d[i - w + 1] + 1.414);
        }
        d[i] = m;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x; if (!d[i]) continue; let m = d[i];
        if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
        if (y < h - 1) {
            m = Math.min(m, d[i + w] + 1);
            if (x < w - 1) m = Math.min(m, d[i + w + 1] + 1.414);
            if (x > 0) m = Math.min(m, d[i + w - 1] + 1.414);
        }
        d[i] = m;
    }
    const vals = [];
    for (let i = 0; i < N; i++) if (mask[i]) vals.push(d[i]);
    if (!vals.length) return 1;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length * 0.9)];
}

// ── Heavy pass: substrate → ink mask → colour clusters → raw skeleton polylines.
// opts.bg = [r,g,b] substrate override. Returns a result carrying per-colour raw
// polylines + binary mask so the cheap refine pass can re-run on slider changes.
export function analyzeSkeletons(sourceCanvas, paperW, paperH, opts = {}) {
    if (!window.TraceSkeleton) throw new Error('TraceSkeleton library not loaded');

    const sw = sourceCanvas.width, sh = sourceCanvas.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const work = document.createElement('canvas'); work.width = w; work.height = h;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(sourceCanvas, 0, 0, w, h);
    const data = wctx.getImageData(0, 0, w, h).data;
    const N = w * h;

    const lab = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const j = i * 4, l = rgbToLab(data[j], data[j + 1], data[j + 2]); lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2]; }

    // substrate: override or border-ring median
    let bg;
    if (opts.bg) { bg = rgbToLab(opts.bg[0], opts.bg[1], opts.bg[2]); }
    else {
        const ring = [];
        const bw = Math.max(2, Math.round(Math.min(w, h) * 0.06));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || x >= w - bw || y < bw || y >= h - bw) { const i = y * w + x; ring.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }
        const med = axis => { const v = ring.map(p => p[axis]).sort((a, b) => a - b); return v[v.length >> 1]; };
        bg = [med(0), med(1), med(2)];
    }
    const bgRgb = opts.bg || (() => { // recover an rgb for the chip
        const rs = [], gs = [], bs = []; const bw = Math.max(2, Math.round(Math.min(w, h) * 0.06));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || x >= w - bw || y < bw || y >= h - bw) { const j = (y * w + x) * 4; rs.push(data[j]); gs.push(data[j + 1]); bs.push(data[j + 2]); }
        const md = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; }; return [md(rs), md(gs), md(bs)];
    })();

    const inkThresh = opts.inkThreshold || 16;
    const inkIdx = [];
    const inkMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) { if (deltaE([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], bg) > inkThresh) { inkIdx.push(i); inkMask[i] = 1; } }
    if (!inkIdx.length) return { w, h, paperW, paperH, bgRgb, colors: [] };

    const cap = 30000, stepS = Math.max(1, Math.floor(inkIdx.length / cap));
    const samples = [];
    for (let s = 0; s < inkIdx.length; s += stepS) { const i = inkIdx[s]; samples.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }
    // Colour separation control: lower tolerance keeps close hues (green vs teal)
    // apart; higher collapses shades of one marker. UI slider → opts.hueTolDeg.
    const hueTol = opts.hueTolDeg != null ? opts.hueTolDeg * Math.PI / 180 : HUE_MERGE_RAD;
    const cents = mergeCentroids(kmeans(samples, K_INIT), hueTol, CHROMA_MIN);

    // Pixel → cluster assignment. HUE-FIRST for chromatic pixels: a stroke's
    // antialias fringe (ink blended toward paper) keeps the ink's hue but shifts
    // L/chroma a lot, so plain ΔE hands fringes to a *neighbouring* ink (green
    // fringe → teal) and skeletonizes ghost outlines in the wrong colour.
    // Hue distance keeps core + fringe together; ΔE only breaks ties and handles
    // neutral (black/grey) pens.
    const cHue = cents.map(hueOf), cChr = cents.map(chromaOf);
    const counts = new Array(cents.length).fill(0);
    const assign = new Int32Array(N).fill(-1);
    for (const i of inkIdx) {
        const pl = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
        const pChr = chromaOf(pl), pHue = hueOf(pl);
        let bi = 0, bd = Infinity;
        for (let c = 0; c < cents.length; c++) {
            const dE = deltaE(pl, cents[c]);
            let d;
            if (pChr >= CHROMA_MIN && cChr[c] >= CHROMA_MIN) {
                d = angDiff(pHue, cHue[c]) * 60 + dE * 0.2;   // hue dominates, ΔE tie-breaks
            } else if (pChr < CHROMA_MIN && cChr[c] < CHROMA_MIN) {
                d = dE;                                        // neutral pixel ↔ neutral pen
            } else {
                d = dE + 25;                                   // chromatic↔neutral mismatch penalty
            }
            if (d < bd) { bd = d; bi = c; }
        }
        assign[i] = bi; counts[bi]++;
    }

    // Spatial majority vote (5×5): any leftover misassigned fringe (a 1–2 px band
    // along a much thicker stroke of another colour) is reassigned to the local
    // majority, so it can't skeletonize into ghost dashes beside the real stroke.
    if (cents.length > 1) {
        const voted = new Int32Array(assign);
        for (const i of inkIdx) {
            const x = i % w, y = (i / w) | 0;
            const tally = {};
            let bestC = assign[i], bestN = 0;
            for (let dy = -2; dy <= 2; dy++) {
                const yy = y + dy; if (yy < 0 || yy >= h) continue;
                for (let dx = -2; dx <= 2; dx++) {
                    const xx = x + dx; if (xx < 0 || xx >= w) continue;
                    const a = assign[yy * w + xx]; if (a < 0) continue;
                    const n = (tally[a] = (tally[a] || 0) + 1);
                    if (n > bestN) { bestN = n; bestC = a; }
                }
            }
            voted[i] = bestC;
        }
        counts.fill(0);
        for (const i of inkIdx) { assign[i] = voted[i]; counts[assign[i]]++; }
    }

    const minCount = inkIdx.length * MIN_CLUSTER_FRAC;
    const keep = cents.map((_, c) => counts[c] >= minCount);

    const rgbAcc = cents.map(() => [0, 0, 0, 0]);
    for (const i of inkIdx) {
        const c = assign[i]; if (!keep[c]) continue;
        const j = i * 4, r = data[j], g = data[j + 1], b = data[j + 2];
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        const wgt = chroma * chroma + 0.04;
        const a = rgbAcc[c]; a[0] += r * wgt; a[1] += g * wgt; a[2] += b * wgt; a[3] += wgt;
    }

    const colors = [];
    for (let c = 0; c < cents.length; c++) {
        if (!keep[c] || rgbAcc[c][3] === 0) continue;
        const rgb = [Math.round(rgbAcc[c][0] / rgbAcc[c][3]), Math.round(rgbAcc[c][1] / rgbAcc[c][3]), Math.round(rgbAcc[c][2] / rgbAcc[c][3])];
        // Reject substrate leakage: too close to the paper, OR pale/low-chroma (a light
        // grey paper tint) that isn't a real pen. Dark ink (low L) is always kept.
        const labC = rgbToLab(rgb[0], rgb[1], rgb[2]);
        const chromaC = Math.hypot(labC[1], labC[2]);
        if (deltaE(labC, bg) < 28) continue;
        if (chromaC < 12 && labC[0] > 70) continue;

        const mask = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (assign[i] === c) mask[i] = 1;
        // Close the band to fill hollow/streaky cores → single centerline on thinning.
        // ADAPTIVE radius from this colour's measured stroke width: thick marker →
        // big close (no doubled traces); fine pen/handwriting → tiny close (no blobbing).
        const halfW = _strokeHalfWidth(mask, w, h);
        const closeR = Math.max(1, Math.min(10, Math.round(halfW * 0.8)));
        const clean = _closeMask(mask, w, h, closeR);

        const traceMask = (m) => {
            const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
            const mx = mc.getContext('2d'); const md = mx.createImageData(w, h);
            for (let i = 0; i < N; i++) { const on = m[i] ? 255 : 0; const j = i * 4; md.data[j] = on; md.data[j + 1] = on; md.data[j + 2] = on; md.data[j + 3] = 255; }
            mx.putImageData(md, 0, 0);
            return (window.TraceSkeleton.fromCanvas(mc).polylines || []).filter(p => p.length >= 8);
        };

        // Centerline polylines (skeletonize ON — pen strokes traced down the middle)
        const rawPolys = traceMask(clean);
        if (!rawPolys.length) continue;

        // Outline polylines (skeletonize OFF — solid fills traced around the edge).
        // The 1px boundary ring (mask − eroded mask) skeletonizes to exactly the
        // contour loop, outer edges and holes alike.
        const er1 = _erode(clean, w, h, 1);
        const ring = new Uint8Array(N);
        for (let i = 0; i < N; i++) ring[i] = clean[i] && !er1[i] ? 1 : 0;
        const outlinePolys = traceMask(ring);

        colors.push({ rgb, name: nearestName(rgbToLab(rgb[0], rgb[1], rgb[2])), count: counts[c], rawPolys, outlinePolys, mask: clean });
    }
    colors.sort((a, b) => b.count - a.count);
    return { w, h, paperW, paperH, bgRgb, colors };
}

// Unit tangent pointing along a→b.
function _tan(a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; }
// Greedily rejoin polyline ends that are close AND collinear — reconnects a
// stroke that skeletonized into pieces because another colour crossed over it.
// Sharp real corners (low collinearity) are left alone. maxGap in working px.
function bridgePolylines(polys, maxGap, minCos) {
    let segs = polys.filter(p => p.length >= 2).map(p => p.slice());
    const outDir = (seg, atEnd) => atEnd ? _tan(seg[seg.length - 2], seg[seg.length - 1]) : _tan(seg[1], seg[0]);
    let changed = true;
    while (changed && segs.length > 1) {
        changed = false;
        let best = null;
        for (let i = 0; i < segs.length; i++) for (let ei = 0; ei < 2; ei++) {
            const Ae = ei ? segs[i][segs[i].length - 1] : segs[i][0];
            const Ad = outDir(segs[i], !!ei);
            for (let j = i + 1; j < segs.length; j++) for (let ej = 0; ej < 2; ej++) {
                const Be = ej ? segs[j][segs[j].length - 1] : segs[j][0];
                const gap = Math.hypot(Ae.x - Be.x, Ae.y - Be.y);
                if (gap > maxGap) continue;
                const Bd = outDir(segs[j], !!ej);
                const cos = -(Ad.x * Bd.x + Ad.y * Bd.y);              // 1 = collinear continuation
                let gx = Be.x - Ae.x, gy = Be.y - Ae.y; const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
                const align = gx * Ad.x + gy * Ad.y;                   // gap points along A's exit
                if (cos > minCos && align > 0.3) {
                    const score = cos + align - gap / (maxGap * 4);
                    if (!best || score > best.score) best = { i, ei, j, ej, score };
                }
            }
        }
        if (!best) break;
        let A = segs[best.i], B = segs[best.j];
        if (!best.ei) A = A.slice().reverse();       // extend from A's tail
        if (best.ej) B = B.slice().reverse();        // B starts at the joining end
        const joined = A.concat(B);
        const hi = Math.max(best.i, best.j), lo = Math.min(best.i, best.j);
        segs.splice(hi, 1); segs.splice(lo, 1); segs.push(joined);
        changed = true;
    }
    return segs;
}

// ── Cheap pass: turn raw skeleton polylines into refined path strings.
// accuracy (0..1): Accurate↔Smooth (high = follow closely, less rounding).
// simplify (0..1): point reduction (high = fewer points / coarser).
// bridgeGap (px): reconnect crossings-broken strokes within this distance.
export function refinePaths(skel, opts = {}) {
    const accuracy = opts.accuracy != null ? opts.accuracy : 0.5;
    const simp = opts.simplify != null ? opts.simplify : 0.4;
    const cornerSharp = opts.cornerSharp != null ? opts.cornerSharp : 0;   // 0..1 crisper corners
    const outline = !!opts.outline;                 // skeletonize OFF → contour loops
    const bridge = opts.bridgeGap != null ? opts.bridgeGap : 0;            // px; 0 = off
    const closeLoops = outline || opts.closeLoops !== false;               // outlines are always loops
    const epsScale = 0.4 + simp * 3.0;              // 0.4 → ~3.4×
    const tension = (1 - accuracy) * 0.95;          // accurate → ~0 (crisp), smooth → ~0.95
    const maxExt = Math.round(2 + (1 - accuracy) * 4); // extend endpoints a touch more when smoothing
    // A knife/crease loop with a tiny seam gap leaves an uncut tab — snap endpoints
    // within ~a stroke-width of each other and emit one closed contour instead.
    const loopTol = outline ? Math.max(8, Math.min(skel.w, skel.h) / 90) : Math.max(4, Math.min(skel.w, skel.h) / 180);
    for (const col of skel.colors) {
        let segs = [];
        for (const poly of (outline ? (col.outlinePolys || []) : col.rawPolys)) {
            const s = simplify(poly, epsScale);
            if (s.length >= 2) segs.push(s);
        }
        // Reconnect crossing-broken strokes (centerline mode only; outlines are loops)
        if (bridge > 0 && !outline) segs = bridgePolylines(segs, bridge, 0.55);
        const paths = [];
        for (let s of segs) {
            const endGap = Math.hypot(s[0].x - s[s.length - 1].x, s[0].y - s[s.length - 1].y);
            const closed = closeLoops && s.length >= 4 && endGap < loopTol;
            if (closed) {
                if (endGap > 1e-3) s[s.length - 1] = { x: s[0].x, y: s[0].y };
                s = s.slice(0, -1);                 // drop duplicate; toPathD wraps + 'Z'
            } else if (s.length >= 2 && col.mask) {
                // open stroke: recover retracted / hooked endpoints against the ink mask
                s[0] = extendEnd(s[0], s[1], col.mask, skel.w, skel.h, maxExt);
                s[s.length - 1] = extendEnd(s[s.length - 1], s[s.length - 2], col.mask, skel.w, skel.h, maxExt);
            }
            paths.push(toPathD(s, tension, cornerSharp, closed));
        }
        col.paths = paths;
    }
    return skel;
}

// Convenience wrapper (heavy + refine with defaults) for one-shot callers.
export function analyzeDrawing(sourceCanvas, paperW, paperH, opts = {}) {
    return refinePaths(analyzeSkeletons(sourceCanvas, paperW, paperH, opts), opts);
}

// Build an SVG from color→method assignments. `assignments` maps color index
// (into result.colors) → method ('thru_cut'|'off_base'|'crease'|'draw'|'ignore').
export function buildSVG(result, assignments, opts = {}) {
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
    // Optional page-outline reference frame, emitted as its own black layer.
    if (opts.frame) {
        body += `  <path d="M0,0 H${w} V${h} H0 Z" fill="none" stroke="rgb(20,20,20)" stroke-width="0.6" vector-effect="non-scaling-stroke" data-method="thru_cut" data-op="frame" data-name="Frame"/>\n`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${paperW}mm" height="${paperH}mm">\n${body}</svg>`;
}
