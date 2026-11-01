import {PIXELS} from './protocol.js';
import {ADC_FULL_SCALE,ADC_BITS,adcStatistics,readAdcStatistics} from './adc.js';
import {fitPolynomial,polynomial} from './data.js';

export class CalibrationAverage {
  constructor(){this.sum=new Float64Array(PIXELS);this.count=0;this.minimum=Infinity;this.peak=0;}
  add(raw){
    if(raw.length!==PIXELS)throw new Error('Unvollständige Kalibrieraufnahme.');
    const adc=adcStatistics(raw);
    if(adc.invalidSamples)throw new Error('Ungültige ADC-Daten. Aufnahme wiederholen und Datenübertragung prüfen.');
    if(adc.clippedSamples)throw new Error(`ADC-Sättigung: ${adc.clippedSamples} Samples bei ${ADC_FULL_SCALE}. Integrationszeit oder Beleuchtung reduzieren und den Assistenten neu beginnen.`);
    for(let i=0;i<PIXELS;i++)this.sum[i]+=raw[i];
    this.count++;this.minimum=Math.min(this.minimum,adc.minimum);this.peak=Math.max(this.peak,adc.peak);
  }
  mean(){if(!this.count)throw new Error('Es wurden keine Bilder aufgenommen.');return Array.from(this.sum,value=>value/this.count);}
  statistics(){return this.count?readAdcStatistics({version:1,bits:ADC_BITS,fullScale:ADC_FULL_SCALE,minimum:this.minimum,peak:this.peak,sampleCount:PIXELS*this.count,clippedSamples:0,invalidSamples:0}):null;}
}

export function calibrationSignal(average,dark){
  if(average.length!==PIXELS||dark.length!==PIXELS)throw new Error('Ungültige Länge der Kalibrieraufnahme.');
  const y=average.map((value,pixel)=>Math.max(0,value-dark[pixel]));
  if(!y.some(value=>value>0))throw new Error('Kein Signal oberhalb des Dunkelbilds. Lichtquelle und Abdeckung prüfen und die Referenz erneut aufnehmen.');
  return {x:Array.from({length:PIXELS},(_,pixel)=>pixel),y};
}

export function calibrationFit(references,requestedDegree='auto'){
  const points=references.flatMap(reference=>reference.points.map(point=>({...point,reference:reference.name,referenceId:reference.id})));
  if(points.some(p=>!Number.isFinite(p.pixel)||p.pixel<0||p.pixel>PIXELS-1||!Number.isFinite(p.wavelength)||p.wavelength<=0))throw new Error('Jede Zuordnung braucht einen Pixel von 0 bis 3693 und eine positive Wellenlänge.');
  const unique=new Map();
  for(const point of points){
    const previous=unique.get(point.pixel);
    if(previous&&Math.abs(previous.wavelength-point.wavelength)>1e-8)throw new Error(`Pixel ${point.pixel} wurde verschiedenen Wellenlängen zugeordnet. Zuordnungen bearbeiten.`);
    unique.set(point.pixel,point);
  }
  if(unique.size<2)throw new Error('Mindestens zwei verschiedene Pixel mit bekannten Wellenlängen zuordnen.');
  const degree=requestedDegree==='auto'?Math.min(3,unique.size-1):Number(requestedDegree);
  const result=fitPolynomial(Array.from(unique.values(),p=>[p.pixel,p.wavelength]),degree);
  // Require a one-to-one mapping over the complete detector, including its ends.
  let previous=polynomial(result.coefficients,0),direction=0;
  for(let pixel=1;pixel<PIXELS;pixel++){
    const wavelength=polynomial(result.coefficients,pixel),sign=Math.sign(wavelength-previous);
    if(!Number.isFinite(wavelength)||!sign||(direction&&sign!==direction))throw new Error('Das Polynom kehrt innerhalb des Sensors um. Niedrigeren Polynomgrad wählen oder Zuordnungen prüfen.');
    direction=sign;previous=wavelength;
  }
  return {...result,degree,points:points.map(p=>({...p,predicted:polynomial(result.coefficients,p.pixel),residual:polynomial(result.coefficients,p.pixel)-p.wavelength}))};
}
