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
        // Radius scales with the working raster so it works at any capture resolution.
        const closeR = Math.max(1, Math.round(Math.min(w, h) / 260));
        const clean = _closeMask(mask, w, h, closeR);

        const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
        const mx = mc.getContext('2d'); const md = mx.createImageData(w, h);
        for (let i = 0; i < N; i++) { const on = clean[i] ? 255 : 0; const j = i * 4; md.data[j] = on; md.data[j + 1] = on; md.data[j + 2] = on; md.data[j + 3] = 255; }
        mx.putImageData(md, 0, 0);

        const res = window.TraceSkeleton.fromCanvas(mc);
        // keep the closed mask for endpoint recovery; drop very short spur polylines
        const rawPolys = (res.polylines || []).filter(p => p.length >= 8);
        if (!rawPolys.length) continue;
        colors.push({ rgb, name: nearestName(rgbToLab(rgb[0], rgb[1], rgb[2])), count: counts[c], rawPolys, mask: clean });
    }
    colors.sort((a, b) => b.count - a.count);
    return { w, h, paperW, paperH, bgRgb, colors };
}

// ── Cheap pass: turn raw skeleton polylines into refined path strings.
// accuracy (0..1): Accurate↔Smooth (high = follow closely, less rounding).
// simplify (0..1): point reduction (high = fewer points / coarser).
export function refinePaths(skel, opts = {}) {
    const accuracy = opts.accuracy != null ? opts.accuracy : 0.5;
    const simp = opts.simplify != null ? opts.simplify : 0.4;
    const cornerSharp = opts.cornerSharp != null ? opts.cornerSharp : 0;   // 0..1 crisper corners
    const closeLoops = opts.closeLoops !== false;                          // snap near-closed loops shut
    const epsScale = 0.4 + simp * 3.0;              // 0.4 → ~3.4×
    const tension = (1 - accuracy) * 0.95;          // accurate → ~0 (crisp), smooth → ~0.95
    const maxExt = Math.round(2 + (1 - accuracy) * 4); // extend endpoints a touch more when smoothing
    // A knife/crease loop with a tiny seam gap leaves an uncut tab — snap endpoints
    // within ~a stroke-width of each other and emit one closed contour instead.
    const loopTol = Math.max(4, Math.min(skel.w, skel.h) / 180);
    for (const col of skel.colors) {
        const paths = [];
        for (const poly of col.rawPolys) {
            let s = simplify(poly, epsScale);
            if (s.length < 2) continue;
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
