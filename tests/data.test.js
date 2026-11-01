import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,parseLibrary,parseCapture,exportCapture,parseConfig,correct,normalize,interpolate,match,fitPolynomial,polynomial,resample} from '../data.js';

test('C# LIBS and .spect formats import and export without cached normalized arrays',()=>{
  const refs=parseLibrary({Name:'Fe',Wavelengths:[501,500,502],Elements:[{Name:'Fe I',Intensities:[3,1,2],IntensitiesNormalized:[1,.33,.67]}]},'LIBS-Fe.json');
  assert.equal(refs[0].name,'Fe I');assert.deepEqual(refs[0].x,[500,501,502]);assert.deepEqual(refs[0].y,[1,3,2]);
  const capture=parseCapture({Name:'Sample',Wavelengths:[500,501],Intensities:[.2,.7]});
  assert.deepEqual(exportCapture(capture).Intensities,[.2,.7]);
  assert.throws(()=>parseLibrary({Elements:[{Intensities:[0]}],Wavelengths:[1,2]}));
  assert.throws(()=>parseCapture({Wavelengths:[1,2],Intensities:[1,NaN]}));
});
test('interpolation handles both exact endpoints and never extrapolates',()=>{
  assert.deepEqual(interpolate({x:[10,20,30],y:[2,4,6]},[0,10,15,20,30,31]),[0,2,3,4,6,0]);
});
test('dark subtraction, C# intensity correction, and zero normalization stay finite',()=>{
  const config={...DEFAULTS,lambda:[400,.5,0,0],normalize:false,units:'relative',resample:3694};
  const result=correct([10,20,30],config,[5,25,10]);
  assert.deepEqual(result.x,[400,400.5,401]);assert.deepEqual(result.y,[5/65535,0,20/65535]);
  assert.deepEqual(normalize([0,0,0]),[0,0,0]);
  assert.throws(()=>correct([0,0],{...config,lambda:[0,0,0,0]}),/distinct/);
});
test('resampling retains all source samples including a final partial group',()=>{
  assert.deepEqual(resample({x:[0,1,2,3,4],y:[0,1,2,3,4]},2),{x:[.5,3],y:[.5,3]});
});
test('descending wavelength calibration is reordered but folding calibration is rejected',()=>{
  const config={...DEFAULTS,lambda:[500,-1,0,0],resample:3694,normalize:false,units:'counts'};
  const reversed=correct([100,200,300],config);
  assert.deepEqual(reversed.x,[498,499,500]);assert.deepEqual(reversed.y,[300,200,100]);
  assert.throws(()=>correct([0,0,0],{...config,lambda:[0,-1,1,0]}),/monotonic/);
});
test('matching reproduces C# formulas and does not label empty references as matches',()=>{
  for(const method of ['SquaresSum','SquaresSumSat','Multiply','Cosine'])assert.ok(Math.abs(match([0,1,.5],[0,1,.5],method)-100)<1e-9);
  assert.equal(match([1,0],[0,1],'SquaresSum'),-100);
  assert.equal(match([1,0],[0,1],'SquaresSumSat'),0);
  assert.equal(match([1,0],[0,1],'Cosine'),0);
  assert.equal(match([1,0],[0,0],'SquaresSumSat'),null);
});
test('config import converts C# ticks and keeps native exports lossless',()=>{
  const imported=parseConfig({LambdaMap:{x0:350,x1:.15},ShPeriod:20,IcgPeriod:14800,TriggerDelay:17,Trigger:true,DarkFrame:[]});
  assert.equal(imported.config.shUs,10);assert.equal(imported.config.icgUs,7400);assert.equal(imported.config.units,'relative');assert.equal(imported.config.triggered,true);
  const config={...DEFAULTS,averages:7,units:'counts',normalize:false};
  const native=parseConfig({...config,LambdaMap:{x0:1,x1:2}});
  assert.equal(native.config.averages,7);assert.equal(native.config.units,'counts');assert.deepEqual(native.config.lambda,DEFAULTS.lambda);
  assert.throws(()=>parseConfig({lambda:[1,2,Infinity,0]}));assert.throws(()=>parseConfig({darkFrame:[1,2]}));
});
test('centered QR fits a cubic across the detector with sub-picometer residual',()=>{
  const coefficients=[350,.12,1.2e-6,-1e-10];const points=[0,400,1200,2300,3200,3693].map(p=>[p,polynomial(coefficients,p)]);
  const result=fitPolynomial(points,3);assert.ok(result.rms<1e-9);
  for(const pixel of [0,1000,3693])assert.ok(Math.abs(polynomial(result.coefficients,pixel)-polynomial(coefficients,pixel))<1e-9);
  assert.throws(()=>fitPolynomial([[1,2],[1,3]],1),/distinct/);
});
