import {validateAmplitude} from './amplitude.js';
export const CALIBRATION_KEY='spectrum-plotter-web.calibration.v2';
export function validateProfile(input){
  if(!input||input.format!=='SpectrumPlotterWebCalibration'||input.version!==2)throw new Error('Keine gültige Web-Kalibrierdatei (Version 2).');
  const coefficients=input.wavelength?.coefficients;
  if(!Array.isArray(coefficients)||coefficients.length!==4||!coefficients.every(Number.isFinite))throw new Error('Ungültiges Wellenlängenpolynom.');
  let previous=coefficients[0],direction=0;
  for(let p=1;p<3694;p++){const v=coefficients.reduceRight((s,c)=>s*p+c,0),sign=Math.sign(v-previous);if(!Number.isFinite(v)||!sign||(direction&&sign!==direction))throw new Error('Wellenlängenpolynom ist nicht monoton.');direction=sign;previous=v;}
  if(!Array.isArray(input.darkFrame)||![0,3694].includes(input.darkFrame.length)||!input.darkFrame.every(v=>Number.isFinite(v)&&v>=0&&v<=4095))throw new Error('Ungültiges Dunkelbild.');
  const points=input.wavelength.points||[];
  if(!Array.isArray(points)||points.length>10000||points.some(p=>!Number.isFinite(p.pixel)||p.pixel<0||p.pixel>3693||!Number.isFinite(p.wavelength)||p.wavelength<=0))throw new Error('Ungültige Kalibrierpunkte.');
  const amplitude=validateAmplitude(input.amplitude);
  if(amplitude&&!input.darkFrame.length)throw new Error('Amplitudenkalibrierung ohne Dunkelbild.');
  const a=input.acquisition;
  if(a&&(!Number.isFinite(a.shUs)||!Number.isFinite(a.icgUs)||a.shUs<10||a.icgUs<7388||a.shUs>2147483647||a.icgUs>2147483647))throw new Error('Ungültige Kalibrier-Aufnahmezeiten.');
  return {format:input.format,version:2,createdAt:String(input.createdAt||''),wavelength:{coefficients:[...coefficients],degree:input.wavelength.degree??null,rms:input.wavelength.rms??null,points:points.map(p=>({pixel:p.pixel,wavelength:p.wavelength,reference:String(p.reference||'').slice(0,120)}))},darkFrame:[...input.darkFrame],amplitude,amplitudeEnabled:input.amplitudeEnabled!==false,acquisition:a?{shUs:a.shUs,icgUs:a.icgUs}:null};
}
export function makeProfile(config,darkFrame,record=null){
  return validateProfile({format:'SpectrumPlotterWebCalibration',version:2,createdAt:record?.createdAt||new Date().toISOString(),wavelength:{coefficients:config.lambda,degree:record?.degree,rms:record?.rms,points:record?.references?.flatMap(r=>r.points.map(p=>({...p,reference:r.name})))||record?.wavelength?.points||[]},darkFrame:Array.from(darkFrame),amplitude:config.amplitude||null,amplitudeEnabled:config.amplitudeEnabled,acquisition:record?.settings?{shUs:record.settings.shUs,icgUs:record.settings.icgUs}:record?.acquisition||{shUs:config.shUs,icgUs:config.icgUs}});
}
export function saveCalibrationProfile(profile){const valid=validateProfile(profile);localStorage.setItem(CALIBRATION_KEY,JSON.stringify(valid));return valid;}
export function loadCalibrationProfile(){const text=localStorage.getItem(CALIBRATION_KEY);return text?validateProfile(JSON.parse(text)):null;}
