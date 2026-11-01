export const AMPLITUDE_DEFAULTS={model:'sigmoid',startNm:380,endNm:780,midpointNm:565,widthNm:85,temperatureK:3000,smoothingNm:15,maxGain:8,lampType:'unspecified',opticalPath:''};
const poly=(c,x)=>c.reduceRight((s,v)=>s*x+v,0);
const median=v=>{const a=[...v].sort((a,b)=>a-b),m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const smoothstep=v=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
const gaussian=(values,sigma)=>values.map((_,i)=>{let sum=0,weight=0;for(let j=Math.max(0,i-Math.ceil(sigma*3));j<Math.min(values.length,i+Math.ceil(sigma*3)+1);j++){const w=Math.exp(-.5*((j-i)/sigma)**2);sum+=values[j]*w;weight+=w;}return sum/weight;});
export function amplitudeOptions(value={}){
  const o={...AMPLITUDE_DEFAULTS,...value};
  if(!['sigmoid','planck'].includes(o.model))throw new Error('Unbekanntes Amplituden-Zielprofil.');
  for(const key of ['startNm','endNm','midpointNm','widthNm','temperatureK','smoothingNm','maxGain'])if(!Number.isFinite(o[key]))throw new Error('Ungültiger Amplitudenparameter.');
  if(o.startNm<200||o.endNm>2000||o.endNm-o.startNm<80||o.midpointNm<=o.startNm||o.midpointNm>=o.endNm||o.widthNm<20||o.widthNm>250||o.temperatureK<2000||o.temperatureK>4000||o.smoothingNm<5||o.smoothingNm>80||o.maxGain<2||o.maxGain>16)throw new Error('Amplitudenparameter außerhalb des gültigen Bereichs.');
  o.lampType=String(o.lampType).slice(0,80);o.opticalPath=String(o.opticalPath).slice(0,300);return o;
}
export function halogenTarget(wavelength,options={}){
  const o={...AMPLITUDE_DEFAULTS,...options};
  if(o.model==='planck'){const logB=nm=>-5*Math.log(nm)-Math.log(Math.expm1(1.438776877e7/(nm*o.temperatureK)));return Math.exp(logB(wavelength)-logB(o.endNm));}
  const sigmoid=nm=>1/(1+Math.exp(-(nm-o.midpointNm)/o.widthNm));
  return .03+.97*(sigmoid(wavelength)-sigmoid(o.startNm))/(sigmoid(o.endNm)-sigmoid(o.startNm));
}
function slopes(x,y){const d=x.slice(1).map((v,i)=>(y[i+1]-y[i])/(v-x[i])),m=[d[0]];for(let i=1;i<x.length-1;i++)m.push(d[i-1]*d[i]<=0?0:2/(1/d[i-1]+1/d[i]));m.push(d.at(-1));return m;}
const cache=new WeakMap();
function cubic(x,y,v){
  let m=cache.get(y);if(!m){m=slopes(x,y);cache.set(y,m);}
  let lo=0,hi=x.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(x[mid]>v)hi=mid;else lo=mid;}
  const h=x[hi]-x[lo],t=(v-x[lo])/h;
  return (2*t*t*t-3*t*t+1)*y[lo]+(t*t*t-2*t*t+t)*h*m[lo]+(-2*t*t*t+3*t*t)*y[hi]+(t*t*t-t*t)*h*m[hi];
}
export function amplitudeGain(calibration,wavelength){
  if(!calibration||wavelength<=calibration.startNm||wavelength>=calibration.endNm)return 1;
  const taper=smoothstep((wavelength-calibration.startNm)/calibration.fadeNm)*smoothstep((calibration.endNm-wavelength)/calibration.fadeNm);
  const value=cubic(calibration.wavelengths,calibration.logGains,wavelength),limit=Math.log(calibration.maxGain);
  return Math.exp(Math.max(-limit,Math.min(limit,value))*taper);
}
export function validateAmplitude(value){
  if(value===null||value===undefined)return null;
  if(value.version!==1||value.kind!=='relative-halogen'||!Array.isArray(value.wavelengths)||!Array.isArray(value.logGains)||value.wavelengths.length<12||value.wavelengths.length>512||value.wavelengths.length!==value.logGains.length)throw new Error('Ungültige Amplitudenkalibrierung.');
  const options=amplitudeOptions(value.options);
  if(!Number.isFinite(value.startNm)||!Number.isFinite(value.endNm)||value.startNm<options.startNm||value.endNm>options.endNm||value.endNm-value.startNm<80||!Number.isFinite(value.fadeNm)||value.fadeNm<5||value.fadeNm>80||!Number.isFinite(value.maxGain)||value.maxGain<2||value.maxGain>16)throw new Error('Ungültiger Amplitudenbereich.');
  if(value.wavelengths[0]!==value.startNm||value.wavelengths.at(-1)!==value.endNm||value.wavelengths.some((v,i)=>!Number.isFinite(v)||(i&&v<=value.wavelengths[i-1]))||value.logGains.some(v=>!Number.isFinite(v)||Math.abs(v)>Math.log(value.maxGain)+1e-9))throw new Error('Ungültige Amplitudenstützstellen.');
  return {...value,options,wavelengths:[...value.wavelengths],logGains:[...value.logGains]};
}
export function learnAmplitude(average,dark,coefficients,settings={}){
  const options=amplitudeOptions(settings);
  if(average.length!==3694||dark.length!==3694||coefficients.length!==4||!coefficients.every(Number.isFinite)||!average.every(v=>Number.isFinite(v)&&v>=0&&v<4095)||!dark.every(v=>Number.isFinite(v)&&v>=0&&v<4095))throw new Error('Ungültige Halogen- oder Dunkelaufnahme.');
  const pairs=Array.from(average,(v,p)=>[poly(coefficients,p),Math.max(0,v-dark[p])]),direction=Math.sign(poly(coefficients,1)-poly(coefficients,0));
  if(!direction||pairs.some((v,i)=>!Number.isFinite(v[0])||(i&&Math.sign(v[0]-pairs[i-1][0])!==direction)))throw new Error('Zuerst eine gültige Wellenlängenkalibrierung bestimmen.');
  if(direction<0)pairs.reverse();
  const start=Math.max(options.startNm,pairs[0][0]),end=Math.min(options.endNm,pairs.at(-1)[0]);
  if(end-start<80)throw new Error('Zu wenig gemeinsamer Wellenlängenbereich für die Halogenkalibrierung.');
  const count=Math.min(257,Math.max(33,Math.ceil((end-start)/2)+1)),step=(end-start)/(count-1),x=[],measured=[];
  let pos=0;
  for(let i=0;i<count;i++){const wl=i===count-1?end:start+i*step,values=[];while(pos<pairs.length&&pairs[pos][0]<wl-step/2)pos++;for(let p=pos;p<pairs.length&&pairs[p][0]<=wl+step/2;p++)values.push(pairs[p][1]);x.push(wl);measured.push(values.length?median(values):0);}
  const floor=Math.max(5,Math.max(...measured)*.01);
  // Learn only in a contiguous band with usable photons, never through a cutoff.
  let best=[0,0],run=0;
  for(let i=0;i<=count;i++){if(i<count&&measured[i]>=floor)continue;if(i-run>best[1]-best[0])best=[run,i];run=i+1;}
  const xs=x.slice(...best),ys=measured.slice(...best);
  if(xs.length<12||xs.at(-1)-xs[0]<80)throw new Error('Halogensignal zu schwach oder unterbrochen. Beleuchtung erhöhen, Lichtweg prüfen oder den Lernbereich anpassen.');
  const sigma=Math.max(1,options.smoothingNm/step),smooth=gaussian(ys,sigma);
  let logs=gaussian(xs.map((wl,i)=>Math.log(halogenTarget(wl,options))-Math.log(smooth[i])),sigma);
  const anchor=Math.max(xs[0],Math.min(xs.at(-1),options.midpointNm)),anchorValue=cubic(xs,logs,anchor),limit=Math.log(options.maxGain);
  let limitedKnots=0;
  logs=logs.map(v=>{const value=v-anchorValue;if(Math.abs(value)>limit)limitedKnots++;return Math.max(-limit,Math.min(limit,value));});
  const calibration={version:1,kind:'relative-halogen',createdAt:new Date().toISOString(),startNm:xs[0],endNm:xs.at(-1),fadeNm:Math.min(25,(xs.at(-1)-xs[0])/6),wavelengths:xs,logGains:logs,maxGain:options.maxGain,options,signalFloorCounts:floor,limitedKnots};
  return {calibration,preview:{x:xs,measured:ys,corrected:ys.map((v,i)=>v*amplitudeGain(calibration,xs[i])),target:xs.map(wl=>halogenTarget(wl,options)),gains:xs.map(wl=>amplitudeGain(calibration,wl))}};
}
