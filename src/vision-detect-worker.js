// Vision page-detection worker.
// Runs OpenCV.js GrabCut + edge-line refinement + geometric validation OFF the main
// thread, so the UI never freezes. Returns 4 page corners (in proc-frame px) or null.

let ready = false;
const pending = [];

try {
  importScripts('https://docs.opencv.org/4.x/opencv.js');
} catch (e) {
  self.postMessage({ type: 'error', message: 'failed to load opencv' });
}

if (self.cv && self.cv.Mat) { ready = true; }
else if (self.cv) { self.cv.onRuntimeInitialized = () => { ready = true; self.postMessage({ type: 'ready' }); drain(); }; }

function drain() { while (pending.length) { const m = pending.shift(); handle(m); } }

self.onmessage = (e) => {
  if (!ready) { pending.push(e.data); return; }
  handle(e.data);
};

const MIN_AREA = 0.15, ANGLE_MIN = 60, ANGLE_MAX = 120, ASPECT_MIN = 1.0, ASPECT_MAX = 2.3;

function order(q) { q = q.slice(); q.sort((a, b) => (a[0]+a[1]) - (b[0]+b[1])); const tl=q[0], br=q[3]; const rem=[q[1],q[2]]; rem.sort((a,b)=>(a[0]-a[1])-(b[0]-b[1])); return [tl, rem[1], br, rem[0]]; }
function angleAt(p,a,b){ const v1=[a[0]-p[0],a[1]-p[1]], v2=[b[0]-p[0],b[1]-p[1]]; const d=v1[0]*v2[0]+v1[1]*v2[1]; const m=Math.hypot(v1[0],v1[1])*Math.hypot(v2[0],v2[1])||1; return Math.acos(Math.max(-1,Math.min(1,d/m)))*180/Math.PI; }
function fitLine(pts){ let cx=0,cy=0; pts.forEach(p=>{cx+=p[0];cy+=p[1];}); cx/=pts.length; cy/=pts.length; let sxx=0,sxy=0,syy=0; pts.forEach(p=>{const dx=p[0]-cx,dy=p[1]-cy; sxx+=dx*dx; sxy+=dx*dy; syy+=dy*dy;}); const th=0.5*Math.atan2(2*sxy,sxx-syy); return {p:[cx,cy],d:[Math.cos(th),Math.sin(th)]}; }
function lineIntersect(l1,l2){ const [x1,y1]=l1.p,[dx1,dy1]=l1.d,[x2,y2]=l2.p,[dx2,dy2]=l2.d; const det=-dx1*dy2+dx2*dy1; if(Math.abs(det)<1e-6) return null; const t=((x2-x1)*(-dy2)-(-dx2)*(y2-y1))/det; return [x1+t*dx1, y1+t*dy1]; }
function refineCorners(P, rough){ if(P.length<24) return null; const M=P.length;
  const idx=rough.map(rc=>{ let bi=0,bd=Infinity; for(let i=0;i<M;i++){const dx=P[i][0]-rc[0],dy=P[i][1]-rc[1];const d=dx*dx+dy*dy; if(d<bd){bd=d;bi=i;}} return bi; });
  const ordv=[0,1,2,3].sort((a,b)=>idx[a]-idx[b]); const sIdx=ordv.map(k=>idx[k]); const lines=[];
  for(let m=0;m<4;m++){ const a=sIdx[m], b=sIdx[(m+1)%4]; const pts=[]; let i=a; while(true){ pts.push(P[i]); if(i===b) break; i=(i+1)%M; if(pts.length>M) break; }
    const t=Math.floor(pts.length*0.18); const mid = pts.length>2*t+4 ? pts.slice(t,pts.length-t) : pts; if(mid.length<2) return null; lines.push(fitLine(mid)); }
  const refined=[]; for(let m=0;m<4;m++){ const ip=lineIntersect(lines[(m+3)%4], lines[m]); if(!ip) return null; refined.push(ip); }
  return order(refined);
}

function handle(msg) {
  const cv = self.cv;
  const { id, data, w, h } = msg;
  let src, rgb, mask, bgd, fgd, bin, cnts, hi, big = null;
  try {
    src = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: w, height: h });
    rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    mask = new cv.Mat(); bgd = new cv.Mat(); fgd = new cv.Mat();
    cv.grabCut(rgb, mask, new cv.Rect(Math.round(w*0.1), Math.round(h*0.1), Math.round(w*0.8), Math.round(h*0.8)), bgd, fgd, 5, cv.GC_INIT_WITH_RECT);
    bin = new cv.Mat(mask.rows, mask.cols, cv.CV_8UC1);
    for (let i = 0; i < mask.rows*mask.cols; i++) { const v = mask.data[i]; bin.data[i] = (v === cv.GC_FGD || v === cv.GC_PR_FGD) ? 255 : 0; }
    cv.medianBlur(bin, bin, 5);
    cnts = new cv.MatVector(); hi = new cv.Mat();
    cv.findContours(bin, cnts, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let bigA = 0;
    for (let i = 0; i < cnts.size(); i++) { const cc = cnts.get(i); const a = cv.contourArea(cc); if (a > bigA) { bigA = a; if (big) big.delete(); big = cc; } else cc.delete(); }
    let quad = null, valid = false, metrics = {}, reasons = [];
    if (big) {
      let hull = new cv.Mat(); cv.convexHull(big, hull, false, true);
      const peri = cv.arcLength(hull, true); let approx = new cv.Mat();
      for (let k = 0.01; k <= 0.10; k += 0.005) { cv.approxPolyDP(hull, approx, k*peri, true); if (approx.rows <= 4) break; }
      let rough = null;
      if (approx.rows === 4) { rough = []; for (let i = 0; i < 4; i++) rough.push([approx.data32S[i*2], approx.data32S[i*2+1]]); }
      else { const rot = cv.minAreaRect(big); const pts = cv.RotatedRect.points(rot); rough = pts.map(p => [p.x, p.y]); }
      hull.delete(); approx.delete();
      const P = []; for (let i = 0; i < big.data32S.length; i += 2) P.push([big.data32S[i], big.data32S[i+1]]);
      quad = refineCorners(P, rough) || order(rough);
      // validate
      let a = 0; for (let i = 0; i < 4; i++) { const p1 = quad[i], p2 = quad[(i+1)%4]; a += p1[0]*p2[1]-p2[0]*p1[1]; }
      const areaFrac = Math.abs(a)/2/(w*h);
      const ang = [angleAt(quad[0],quad[3],quad[1]), angleAt(quad[1],quad[0],quad[2]), angleAt(quad[2],quad[1],quad[3]), angleAt(quad[3],quad[2],quad[0])];
      const wTop=Math.hypot(quad[1][0]-quad[0][0],quad[1][1]-quad[0][1]), wBot=Math.hypot(quad[2][0]-quad[3][0],quad[2][1]-quad[3][1]);
      const hL=Math.hypot(quad[3][0]-quad[0][0],quad[3][1]-quad[0][1]), hR=Math.hypot(quad[2][0]-quad[1][0],quad[2][1]-quad[1][1]);
      const ww=(wTop+wBot)/2, hh=(hL+hR)/2, aspect=Math.max(ww,hh)/Math.max(1,Math.min(ww,hh));
      metrics = { areaFrac:+areaFrac.toFixed(3), angles:ang.map(x=>Math.round(x)), aspect:+aspect.toFixed(2) };
      if (areaFrac < MIN_AREA) reasons.push('too small');
      if (ang.some(x => x < ANGLE_MIN || x > ANGLE_MAX)) reasons.push('bad angle');
      if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) reasons.push('bad aspect');
      valid = reasons.length === 0;
    } else reasons.push('no region');
    self.postMessage({ type: 'result', id, quad: valid ? quad : null, valid, metrics, reasons });
  } catch (err) {
    self.postMessage({ type: 'result', id, quad: null, valid: false, reasons: ['error:' + (err && err.message)] });
  } finally {
    [src, rgb, mask, bgd, fgd, bin, hi, big].forEach(m => { try { m && m.delete(); } catch (e) {} });
    try { cnts && cnts.delete(); } catch (e) {}
  }
}
