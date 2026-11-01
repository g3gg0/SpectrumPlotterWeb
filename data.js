import {amplitudeGain,validateAmplitude} from './amplitude.js';
export const COLORS = ['#b99aff','#faad66','#55d8b2','#f280a9','#7dafff','#d2db75'];
export const DEFAULTS = {
  shUs:10, icgUs:7400, delayUs:0, averages:1, triggered:false,
  normalize:true, units:'counts', resample:1850, encoding:'packed12', matchMethod:'SquaresSumSat',
  autoMatch:true, autoCapture:false, autoClear:false,
  lambda:[450,0.2,0,0], amplitude:null, amplitudeEnabled:true,
};
export const polynomial = (coefficients, x) => coefficients.reduceRight((sum, coefficient) => sum * x + coefficient, 0);
export const id = () => crypto.randomUUID();
export function maximum(values) { let value = -Infinity; for (const x of values) if (x > value) value = x; return value; }
export function normalize(values) {
  const peak = maximum(values);
  return Array.from(values, v => peak > 0 ? v / peak : 0);
}
function vector(value, name) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 1000000 || !value.every(v => typeof v === 'number' && Number.isFinite(v)))
    throw new Error(`${name}: expected 2–1,000,000 finite numbers`);
  return value;
}
export function spectrum(wavelengths, intensities) {
  const x = vector(wavelengths, 'Wavelengths'), y = vector(intensities, 'Intensities');
  if (x.length !== y.length) throw new Error('Wavelengths and intensities have different lengths');
  const indices = Array.from(x.keys()).sort((a,b) => x[a] - x[b]);
  const xs = [], ys = [];
  for (const i of indices) {
    if (xs.at(-1) === x[i]) ys[ys.length-1] = Math.max(ys.at(-1), y[i]);
    else { xs.push(x[i]); ys.push(y[i]); }
  }
  if (xs.length < 2) throw new Error('Spectrum needs at least two distinct wavelengths');
  return {x:xs, y:ys};
}
export function parseLibrary(object, filename = '') {
  if (!object || typeof object !== 'object' || !Array.isArray(object.Elements) || !object.Elements.length)
    throw new Error('Not a LIBS library: expected Wavelengths and Elements');
  if (object.Elements.length > 256) throw new Error('Library contains too many species');
  const name = String(object.Name || filename.replace(/^LIBS-|\.json$/gi, '') || 'Library').slice(0,120);
  return object.Elements.map((element, index) => ({
    id:id(), group:name, name:String(element.Name || `${name} ${index+1}`).slice(0,120),
    ...spectrum(object.Wavelengths, element.Intensities), color:COLORS[index % COLORS.length],
    visible:false, source:filename, demo:false, score:null,
  }));
}
export function parseCapture(object, filename = '') {
  if (!object || !object.Wavelengths || !object.Intensities) throw new Error('Not a .spect capture');
  return {id:id(), name:String(object.Name || filename || 'Imported spectrum').slice(0,120),
    ...spectrum(object.Wavelengths, object.Intensities), color:COLORS[0], visible:true,
    time:object.Time || null, source:'import', score:null, metadata:object.Metadata || null};
}
export function exportCapture(capture) {
  return {Name:capture.name, Color:capture.color, Wavelengths:Array.from(capture.x), Intensities:Array.from(capture.y), Time:capture.time, Metadata:capture.metadata || null};
}
export function parseConfig(object) {
  const result = {...DEFAULTS};
  if (object.LambdaMap && !object.lambda) {
    const readPoly = (value, fallback) => value ? ['x0','x1','x2','x3'].map(key => value[key] ?? 0) : fallback;
    result.lambda = readPoly(object.LambdaMap, DEFAULTS.lambda);
    result.shUs = (object.ShPeriod ?? 20) / 2;
    result.icgUs = (object.IcgPeriod ?? 14800) / 2;
    result.delayUs = object.TriggerDelay ?? 0; result.triggered = Boolean(object.Trigger);
    result.autoMatch = Boolean(object.TriggerAutoMatch); result.autoCapture = Boolean(object.TriggerAutoCapture);
    result.autoClear = Boolean(object.TriggerAutoClear); result.normalize = Boolean(object.TriggerAutoNormalize);
    result.units = 'counts'; result.resample = object.ResampleResolution ?? 1024;
    result.matchMethod = object.MatchMethod ?? 'SquaresSumSat';
  } else {
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(object, key)) result[key] = object[key];
  }
  for (const key of ['lambda']) {
    if (!Array.isArray(result[key]) || result[key].length !== 4 || !result[key].every(Number.isFinite)) throw new Error(`Invalid ${key} polynomial`);
  }
  for (const key of ['shUs','icgUs','delayUs','averages','resample']) if (!Number.isFinite(result[key])) throw new Error(`Invalid ${key}`);
  result.units='counts';
  result.amplitude=validateAmplitude(result.amplitude);
  result.amplitudeEnabled=result.amplitudeEnabled!==false;
  if (!['Multiply','SquaresSum','SquaresSumSat','Cosine'].includes(result.matchMethod)) throw new Error('Unknown matching method');
  if (!['raw16','packed12','log10','log8'].includes(result.encoding)) throw new Error('Invalid sample encoding');
  result.resample = Math.min(3694, Math.max(64, Math.round(result.resample)));
  for (const key of ['triggered','normalize','autoMatch','autoCapture','autoClear']) result[key] = Boolean(result[key]);
  let darkFrame = (object.lambda?object.darkFrame??object.DarkFrame:object.DarkFrame??object.darkFrame) || [];
  if (!Array.isArray(darkFrame) || ![0,3694].includes(darkFrame.length) || !darkFrame.every(v => Number.isFinite(v) && v >= 0 && v <= 65535)) throw new Error('Dark frame must contain 3694 finite ADC values');
  return {config:result, darkFrame};
}
export function correct(raw, config, dark = [], stride = 1) {
  if (!Number.isInteger(stride) || stride < 1 || stride > 64) throw new Error('Invalid sample stride');
  const pairs = Array.from(raw, (value, pixel) => {
    pixel *= stride;
    const wavelength = polynomial(config.lambda, pixel);
    const counts = Math.max(0, value - (dark[pixel] || 0));
    const intensity = counts * (config.amplitudeEnabled!==false?amplitudeGain(config.amplitude,wavelength):1);
    if (!Number.isFinite(wavelength) || !Number.isFinite(intensity)) throw new Error('Calibration produced non-finite values');
    return [wavelength, intensity];
  });
  const direction = Math.sign(pairs[1][0] - pairs[0][0]);
  if (!direction || pairs.some((p,i) => i > 0 && Math.sign(p[0] - pairs[i-1][0]) !== direction))
    throw new Error('Wavelength calibration must be strictly monotonic with distinct wavelengths across the detector');
  const corrected = spectrum(pairs.map(p => p[0]), pairs.map(p => p[1]));
  const grouped = resample(corrected, config.resample);
  if (config.normalize) grouped.y = normalize(grouped.y);
  return grouped;
}
export function resample({x,y}, resolution) {
  const groups = Math.max(2, Math.min(x.length, Math.round(resolution)));
  const xs = [], ys = [];
  for (let i=0; i<groups; i++) {
    const start = Math.floor(i*x.length/groups), end = Math.floor((i+1)*x.length/groups);
    let sx=0, sy=0;
    for (let j=start; j<end; j++) { sx+=x[j]; sy+=y[j]; }
    xs.push(sx/(end-start)); ys.push(sy/(end-start));
  }
  return {x:xs,y:ys};
}
export function interpolate(reference, wavelengths) {
  const {x,y} = reference;
  return wavelengths.map(wavelength => {
    if (wavelength < x[0] || wavelength > x.at(-1)) return 0;
    let lo=0, hi=x.length-1;
    while (hi-lo>1) { const mid=(lo+hi)>>1; if (x[mid]>wavelength) hi=mid; else lo=mid; }
    return y[lo] + (y[hi]-y[lo]) * ((wavelength-x[lo])/(x[hi]-x[lo]));
  });
}
// Scores reproduce the C# formulas; negative squared-error scores are retained.
export function match(sample, reference, method = 'SquaresSumSat') {
  const a=normalize(sample), b=normalize(reference);
  let numerator=0, denominator=0, energyB=0;
  for (let i=0;i<a.length;i++) {
    if (method === 'SquaresSum' || method === 'SquaresSumSat') {
      const difference=method==='SquaresSumSat' ? Math.max(0,b[i]-a[i]) : b[i]-a[i];
      numerator+=difference*difference; denominator+=b[i]*b[i];
    } else { numerator+=a[i]*b[i]; denominator+=a[i]*a[i]; energyB+=b[i]*b[i]; }
  }
  if (!denominator || !maximum(b)) return null;
  if (method==='Cosine') return numerator/Math.sqrt(denominator*energyB)*100;
  return (method==='Multiply' ? numerator/denominator : 1-numerator/denominator)*100;
}
export function findPeaks(signal, limit = 8) {
  if (!signal) return [];
  const {x,y}=signal, peak=maximum(y), candidates=[];
  for (let i=2;i<y.length-2;i++) {
    if (y[i]>peak*.07 && y[i]>y[i-1] && y[i]>=y[i+1]) {
      const localBaseline=Math.min(...y.slice(Math.max(0,i-8),Math.min(y.length,i+9)));
      candidates.push({x:x[i],y:y[i],prominence:y[i]-localBaseline,index:i});
    }
  }
  const selected=[];
  for (const p of candidates.sort((a,b)=>b.prominence-a.prominence)) {
    if (selected.every(other=>Math.abs(other.index-p.index)>8)) selected.push(p);
    if (selected.length>=limit) break;
  }
  return selected;
}
export function fitPolynomial(points, degree=3) {
  if (!Number.isInteger(degree) || degree < 1 || degree > 3) throw new Error('Polynomial degree must be 1–3');
  if (points.length > 10000 || !points.every(p => p.length === 2 && p.every(Number.isFinite))) throw new Error('Use at most 10000 finite calibration point pairs');
  if (points.length<degree+1) throw new Error(`At least ${degree+1} calibration points are required`);
  if (new Set(points.map(p=>p[0])).size < degree+1) throw new Error('Calibration pixels must be distinct');
  const center=points.reduce((s,p)=>s+p[0],0)/points.length;
  const scale=Math.max(...points.map(p=>Math.abs(p[0]-center))) || 1;
  // QR with reorthogonalization on a centered/scaled Vandermonde matrix.
  const columns=Array.from({length:degree+1},(_,j)=>points.map(p=>((p[0]-center)/scale)**j));
  const r=Array.from({length:degree+1},()=>Array(degree+1).fill(0)), q=[];
  for (let j=0;j<=degree;j++) {
    const v=[...columns[j]];
    for (let pass=0;pass<2;pass++) for (let i=0;i<j;i++) {
      const projection=v.reduce((s,n,k)=>s+n*q[i][k],0);
      r[i][j]+=projection; v.forEach((n,k)=>v[k]=n-projection*q[i][k]);
    }
    const norm=Math.hypot(...v);
    if (norm<1e-10) throw new Error('Calibration points are degenerate');
    r[j][j]=norm; q.push(v.map(n=>n/norm));
  }
  const coefficients=q.map(col=>col.reduce((s,v,k)=>s+v*points[k][1],0));
  for (let j=degree;j>=0;j--) {
    for (let k=j+1;k<=degree;k++) coefficients[j]-=r[j][k]*coefficients[k];
    coefficients[j]/=r[j][j];
  }
  const binomial=[[1],[1,1],[1,2,1],[1,3,3,1]], result=[0,0,0,0];
  for (let j=0;j<=degree;j++) for (let k=0;k<=j;k++) result[k]+=coefficients[j]*binomial[j][k]*(-center)**(j-k)/scale**j;
  const rms=Math.sqrt(points.reduce((s,p)=>s+(polynomial(result,p[0])-p[1])**2,0)/points.length);
  return {coefficients:result,rms};
}

export function demoData() {
  const x=Array.from({length:2400},(_,i)=>350+i*450/2399);
  const gaussian=(v,center,width)=>Math.exp(-.5*((v-center)/width)**2);
  const peaksA=[[393.4,.64],[422.7,.43],[445.5,.3],[527,.25],[589.1,.97],[616.2,.38],[671.7,.45],[766.5,.67]];
  const peaksB=[[383.8,.3],[438.4,.76],[486.1,.6],[518.4,.9],[558.8,.28],[656.3,.85],[743,.3]];
  const curve=peaks=>x.map(v=>peaks.reduce((s,[c,a])=>s+a*gaussian(v,c,.45),0));
  const a=curve(peaksA), b=curve(peaksB);
  return {signal:{x,y:x.map((v,i)=>.025+.025*gaussian(v,485,75)+a[i]*.87+b[i]*.23+.005*Math.sin(i*2.12)+.003*Math.cos(i*1.32)),name:'Synthetic demonstration',source:'demo',time:null},
    references:[{id:'demo-a',name:'Demo A',group:'Synthetic',x,y:a,color:COLORS[0],visible:false,demo:true,score:null},{id:'demo-b',name:'Demo B',group:'Synthetic',x,y:b,color:COLORS[1],visible:false,demo:true,score:null}]};
}
