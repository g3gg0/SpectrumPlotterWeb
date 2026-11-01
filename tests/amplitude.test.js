import test from 'node:test';
import assert from 'node:assert/strict';
import {learnAmplitude,halogenTarget,amplitudeGain,validateAmplitude} from '../amplitude.js';
import {makeProfile,validateProfile,saveCalibrationProfile,loadCalibrationProfile,CALIBRATION_KEY} from '../calibration-profile.js';
import {correct,DEFAULTS,normalize} from '../data.js';

const lambda=[350,.12,0,0],dark=Array(3694).fill(100);
function reference(brightness=800){return dark.map((v,p)=>{const wl=350+.12*p,target=halogenTarget(wl),response=.5+1.5*(wl-380)/400;return v+Math.max(0,target)*Math.max(.3,response)*brightness;});}
// Outside the configured visible band use bounded plausible raw data.
const lamp=()=>reference().map(v=>Math.min(3900,v));
test('halogen correction learns broad response distortion and substantially improves relative shape',()=>{
  const result=learnAmplitude(lamp(),dark,lambda),{preview:p,calibration:c}=result;
  const indices=p.x.map((wl,i)=>wl>430&&wl<730?i:-1).filter(i=>i>=0);
  const a=normalize(indices.map(i=>p.measured[i])),b=normalize(indices.map(i=>p.corrected[i])),t=normalize(indices.map(i=>p.target[i]));
  const mse=v=>v.reduce((s,x,i)=>s+(x-t[i])**2,0)/v.length;
  assert.ok(mse(b)<mse(a)*.2,`${mse(b)} vs ${mse(a)}`);
  assert.equal(c.kind,'relative-halogen');assert.ok(c.wavelengths.length<=257);
});
test('smooth bounded gain returns continuously to unity at coverage boundaries',()=>{
  const {calibration:c}=learnAmplitude(lamp(),dark,lambda,{maxGain:4});
  assert.equal(amplitudeGain(c,c.startNm-100),1);assert.equal(amplitudeGain(c,c.endNm+100),1);
  for(let wl=c.startNm;wl<c.endNm;wl+=.1){const gain=amplitudeGain(c,wl);assert.ok(gain>=.25-1e-10&&gain<=4+1e-10);assert.ok(Math.abs(amplitudeGain(c,wl+.001)-gain)<.001);}
  assert.ok(Math.abs(amplitudeGain(c,c.startNm-c.fadeNm+.001)-1)<1e-6);
  assert.ok(Math.abs(amplitudeGain(c,c.endNm+c.fadeNm-.001)-1)<1e-6);
  for(const boundary of [c.startNm,c.endNm])assert.ok(Math.abs(amplitudeGain(c,boundary+.001)-amplitudeGain(c,boundary-.001))<1e-6);
});
test('narrow outliers do not become narrow gain spikes and dark data is rejected',()=>{
  const normal=lamp(),outlier=[...normal];outlier[1800]=4094;
  const a=learnAmplitude(normal,dark,lambda).calibration,b=learnAmplitude(outlier,dark,lambda).calibration;
  assert.ok(Math.abs(amplitudeGain(a,566)-amplitudeGain(b,566))<.01);
  assert.throws(()=>learnAmplitude(dark,dark,lambda),/schwach/);
  assert.throws(()=>learnAmplitude(Array(3694).fill(4095),dark,lambda),/Ungültige/);
  assert.throws(()=>learnAmplitude(normal,dark,[0,0,0,0]),/Wellenlängen/);
});
test('optional Planck target uses the stated color temperature, sigmoid peaks in slope near green/yellow',()=>{
  assert.ok(halogenTarget(450,{model:'planck',temperatureK:3200})>halogenTarget(450,{model:'planck',temperatureK:2800}));
  const slope=wl=>halogenTarget(wl+1)-halogenTarget(wl-1);
  assert.ok(slope(565)>slope(400));assert.ok(slope(565)>slope(750));
  const {calibration:c}=learnAmplitude(lamp(),dark,lambda,{model:'planck',temperatureK:3000});assert.equal(validateAmplitude(c).options.temperatureK,3000);
});
test('applied amplitude changes processed intensities while preserving raw data and supports bypass',()=>{
  const raw=lamp(),calibration=learnAmplitude(raw,dark,lambda).calibration;
  const config={...DEFAULTS,lambda,normalize:false,resample:3694,amplitude:calibration};
  const corrected=correct(raw,config,dark),bypassed=correct(raw,{...config,amplitudeEnabled:false},dark);
  assert.notEqual(corrected.y[2000],bypassed.y[2000]);assert.equal(raw[0],lamp()[0]);
});
test('native profile and local storage round trip preserve precise dark, response and anchors',()=>{
  const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const amplitude=learnAmplitude(lamp(),dark,lambda).calibration;
  const profile=makeProfile({...DEFAULTS,lambda,amplitude},Array(3694).fill(100.5),{degree:1,rms:.02,references:[{name:'Line lamp',points:[{pixel:0,wavelength:350},{pixel:3000,wavelength:710}]}]});
  saveCalibrationProfile(profile);assert.ok(values.has(CALIBRATION_KEY));
  const restored=loadCalibrationProfile();assert.equal(restored.darkFrame[0],100.5);assert.equal(restored.wavelength.points.length,2);
  assert.equal(amplitudeGain(restored.amplitude,620),amplitudeGain(amplitude,620));
  assert.equal('LambdaMap'in restored,false);assert.equal('IntensityScaling'in restored,false);
  const serialized=JSON.stringify(profile);
  assert.deepEqual(validateProfile(JSON.parse(serialized)),profile);
  assert.throws(()=>saveCalibrationProfile({...profile,darkFrame:[1,2]}));assert.equal(values.get(CALIBRATION_KEY),serialized);
  assert.throws(()=>validateProfile({...profile,amplitude:{...amplitude,logGains:[NaN]}}));
  delete globalThis.localStorage;
});
