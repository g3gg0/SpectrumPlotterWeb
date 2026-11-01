import {SpectrumPlot} from './plot.js';
import {CalibrationAverage,calibrationSignal,calibrationFit} from './calibration.js';
import {timing} from './protocol.js';

const $=id=>document.getElementById(id);
const node=(tag,className='',text='')=>{const el=document.createElement(tag);el.className=className;el.textContent=text;return el;};
const button=(text,handler)=>{const el=node('button','button small',text);el.type='button';el.onclick=handler;return el;};

export class CalibrationWizard {
  constructor({device,getSettings,connect,onApply,log=()=>{}}){
    Object.assign(this,{device,getSettings,connect,onApply,log});this.session=0;this.busy=false;
    this.dialog=$('calibration-wizard');
    this.plot=new SpectrumPlot($('wizard-canvas'),{xAxis:'pixel',tooltip:$('wizard-tooltip'),onSelect:point=>this.selectPixel(point.x)});
    this.plot.peaks=false;
    $('wizard-close').onclick=() => this.cancel();$('wizard-cancel').onclick=()=>this.cancel();
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.cancel();});
    $('wizard-connect').onclick=async()=>{
      if(this.connecting)return;const session=this.session;this.connecting=true;this.render();
      try{await this.connect();if(session===this.session)this.error(this.device.verified?'':'Verbindung fehlgeschlagen. Port und Firmware prüfen.');}
      catch(error){if(session===this.session)this.error(error.message);}
      finally{if(session===this.session){this.connecting=false;this.render();}}
    };
    $('wizard-dark-start').onclick=()=>this.capture('dark');$('wizard-light-start').onclick=()=>this.capture('light');
    $('wizard-point-form').onsubmit=event=>{event.preventDefault();this.addPoint();};
    $('wizard-pixel').oninput=()=>this.markers();
    $('wizard-fit-plot').onclick=()=>this.plot.fit();
    $('wizard-retake').onclick=()=>{this.retakeId=this.current?.id;$('wizard-reference-name').value=this.current?.name||'';this.current=null;this.show('light');};
    $('wizard-back-to-review').onclick=()=>{this.current=null;this.retakeId=null;this.show('review');};
    $('wizard-accept-reference').onclick=()=>this.acceptReference();
    $('wizard-more').onclick=()=>{this.current=null;this.retakeId=null;$('wizard-reference-name').value=`Referenz ${this.references.length+1}`;this.show('light');};
    $('wizard-degree').onchange=()=>this.renderReview();
    $('wizard-finish').onclick=()=>this.finish();
  }
  get active(){return this.dialog.open;}
  async open(){
    if(this.active)return;
    const session=++this.session;this.references=[];this.current=null;this.retakeId=null;this.dark=null;this.result=null;this.settings=null;this.controller=null;this.connecting=false;this.busy=true;this.stage='dark';
    $('wizard-timing').textContent='Messung vorbereiten …';
    $('wizard-degree').value='auto';$('wizard-average-count').disabled=false;$('wizard-average-count').value='32';
    $('wizard-dark-summary').textContent='Mit „Fertig“ werden Dunkelbild und Polynom gespeichert.';
    this.dialog.showModal();this.error('');this.render();
    try{
      if(this.device.task){
        if(this.getSettings().triggered){
          const port=this.device.port;
          await this.device.disconnect();
          if(session!==this.session)return;
          if(port)await this.device.connect(port);
          if(session!==this.session){await this.device.disconnect();return;}
        }else{this.device.pause();await this.device.task;}
      }
      if(session!==this.session)return;
      this.settings=timing({...this.getSettings(),triggered:false,averages:1});
      $('wizard-timing').textContent=`SH ${this.settings.shUs} µs · ICG ${this.settings.icgUs} µs · automatische Einzelbilder`;
    }catch(error){if(session===this.session)this.error(error.message);}
    finally{if(session===this.session){this.busy=false;this.render();}}
  }
  show(stage){this.stage=stage;this.error('');this.render();if(stage==='review')this.renderReview();}
  render(){
    for(const stage of ['dark','light','assign','review'])$(`wizard-${stage}-step`).hidden=this.busy||this.stage!==stage;
    $('wizard-progress-section').hidden=!this.busy;
    for(const item of this.dialog.querySelectorAll('[data-step]'))item.classList.toggle('active',item.dataset.step===this.stage);
    $('wizard-connect').hidden=this.device.verified; $('wizard-connect').disabled=this.busy||this.connecting;
    $('wizard-dark-start').disabled=!this.device.verified||this.busy;
    $('wizard-light-start').disabled=!this.device.verified||this.busy;
    if(!this.device.verified&&!this.busy&&!$('wizard-error').textContent)this.error('Verbinde das Messgerät, bevor du die Aufnahme bestätigst.');
    if(this.busy&&!this.controller){$('wizard-progress-title').textContent='Laufende Messung abschließen …';$('wizard-progress-count').textContent='Bitte kurz warten';$('wizard-progress').removeAttribute('value');$('wizard-progress-percent').textContent='';}
  }
  error(message){$('wizard-error').textContent=message;$('wizard-error').hidden=!message;}
  async capture(kind){
    if(this.busy)return;
    const session=this.session;this.error('');
    try{
      if(!this.device.verified)throw new Error('Verbinde zuerst das Messgerät.');
      if(!this.settings)this.settings=timing({...this.getSettings(),triggered:false,averages:1});
      const count=kind==='dark'?Number($('wizard-average-count').value):this.frameCount;
      if(![16,32,64,128].includes(count))throw new Error('Ungültige Anzahl der Einzelbilder.');
      this.busy=true;this.controller=new AbortController();this.render();
      $('wizard-progress-title').textContent=kind==='dark'?'Dunkelbild wird gemittelt …':'Referenzspektrum wird gemittelt …';
      const average=new CalibrationAverage();let metadata;
      await this.device.captureBatch(this.settings,{count,signal:this.controller.signal,onFrame:(raw,info)=>{average.add(raw);metadata=info;},onProgress:(completed,total)=>{
        if(session!==this.session)return;
        $('wizard-progress').max=total;$('wizard-progress').value=completed;
        $('wizard-progress-count').textContent=`${completed} / ${total} Bilder`;$('wizard-progress-percent').textContent=`${Math.round(completed/total*100)} %`;
      }});
      if(session!==this.session)return;
      if(kind==='dark'){
        this.dark=average.mean();this.frameCount=count;$('wizard-average-count').disabled=true;
        $('wizard-dark-summary').textContent=`Dunkelbild: ${count} Einzelbilder · SH ${this.settings.shUs} µs · wird mit „Fertig“ gespeichert.`;
        this.stage='light';$('wizard-reference-name').value='Referenz 1';
        this.log(`Kalibrierassistent: Dunkelbild aus ${count} Einzelbildern aufgenommen.`);
      }else{
        const values=average.mean();const signal=calibrationSignal(values,this.dark);
        this.current={id:this.retakeId||crypto.randomUUID(),name:$('wizard-reference-name').value.trim()||`Referenz ${this.references.length+1}`,average:values,points:[],metadata:{...metadata,hostAverages:count,adc:average.statistics()}};
        this.retakeId=null;
        this.stage='assign';this.showReference(signal);
        this.log(`Kalibrierassistent: ${this.current.name} aus ${count} Einzelbildern aufgenommen.`);
      }
    }catch(error){if(session===this.session){this.error(error.name==='AbortError'?'Aufnahme abgebrochen. Bitte das Gerät erneut verbinden.':error.message);this.log(`Kalibrierassistent: ${error.message}`,'error');}}
    finally{if(session===this.session){this.controller=null;this.busy=false;this.render();}}
  }
  showReference(signal=calibrationSignal(this.current.average,this.dark)){
    $('wizard-reference-title').textContent=this.current.name;
    $('wizard-pixel').value='';$('wizard-wavelength').value='';
    this.plot.markers=[];this.plot.setData({signal,captures:[],references:[],unit:'Intensität (ADC counts)'});this.plot.fit();this.renderPoints();
  }
  selectPixel(pixel){if(this.stage!=='assign'||this.busy)return;$('wizard-pixel').value=pixel;this.markers();$('wizard-wavelength').focus({preventScroll:true});}
  markers(){
    this.plot.markers=(this.current?.points||[]).map(point=>({x:point.pixel,label:`${point.wavelength} nm`}));
    const input=$('wizard-pixel');if(input.value!==''&&input.validity.valid)this.plot.markers.push({x:Number(input.value),label:'Auswahl',color:'#ffffff'});
    this.plot.schedule();
  }
  addPoint(){
    if(!this.current)return;
    const pixel=Number($('wizard-pixel').value),wavelength=Number($('wizard-wavelength').value);
    if(!Number.isFinite(pixel)||pixel<0||pixel>3693||!Number.isFinite(wavelength)||wavelength<=0){this.error('Gültige Pixelposition und Wellenlänge eingeben.');return;}
    const existing=this.current.points.find(p=>p.pixel===pixel);
    if(existing)existing.wavelength=wavelength;else this.current.points.push({pixel,wavelength});
    this.current.points.sort((a,b)=>a.pixel-b.pixel);this.error('');$('wizard-pixel').value='';$('wizard-wavelength').value='';this.renderPoints();
  }
  renderPoints(){
    const list=$('wizard-current-points');list.replaceChildren();
    if(!this.current.points.length)list.append(node('p','muted','Noch keine Zuordnung. Peak im Plot anklicken oder die Pixelposition direkt eingeben.'));
    for(const point of this.current.points){
      const row=node('div','wizard-point-row');row.append(node('span','mono',`Pixel ${point.pixel}`));
      const input=node('input');input.type='number';input.min='0.000001';input.step='any';input.value=point.wavelength;input.setAttribute('aria-label',`Wellenlänge für Pixel ${point.pixel}`);
      input.onchange=()=>{if(input.value!==''&&input.validity.valid){point.wavelength=Number(input.value);this.error('');this.markers();}else this.error('Die Wellenlänge muss positiv sein.');};
      row.append(input,node('span','','nm'),button('Entfernen',()=>{this.current.points=this.current.points.filter(p=>p!==point);this.renderPoints();}));list.append(row);
    }
    $('wizard-accept-reference').disabled=!this.current.points.length;this.markers();
    $('wizard-back-to-review').hidden=!this.references.length;
  }
  acceptReference(){
    if(!this.current?.points.length)return;
    if(Array.from($('wizard-current-points').querySelectorAll('input')).some(input=>input.value===''||!input.validity.valid)){this.error('Bitte alle Wellenlängen gültig eingeben.');return;}
    const index=this.references.findIndex(ref=>ref.id===this.current.id);
    const accepted=structuredClone(this.current);
    if(index>=0)this.references[index]=accepted;else this.references.push(accepted);
    this.current=null;this.show('review');
  }
  renderReview(){
    const list=$('wizard-reference-list');list.replaceChildren();
    for(const reference of this.references){
      const row=node('div','wizard-reference-row');row.append(node('strong','',reference.name),node('span','muted',`${reference.points.length} Zuordnungen`),button('Bearbeiten',()=>{this.current=structuredClone(reference);this.show('assign');this.showReference();}),button('Entfernen',()=>{this.references=this.references.filter(r=>r.id!==reference.id);this.renderReview();}));list.append(row);
    }
    this.result=null;$('wizard-fit-error').textContent='';$('wizard-fit-summary').textContent='';$('wizard-coefficients').textContent='';$('wizard-residuals').replaceChildren();
    try{
      this.result=calibrationFit(this.references,$('wizard-degree').value);
      $('wizard-fit-summary').textContent=`Grad ${this.result.degree} · ${this.result.points.length} Zuordnungen · RMS ${this.result.rms.toPrecision(4)} nm`;
      $('wizard-coefficients').textContent=this.result.coefficients.map((coefficient,i)=>`a${i} = ${coefficient.toPrecision(12)}`).join('   ');
      const table=node('table');const head=node('tr');for(const text of ['Referenz','Pixel','λ bekannt / nm','λ Polynom / nm','Abweichung / nm'])head.append(node('th','',text));table.append(head);
      for(const point of this.result.points){const row=node('tr');for(const text of [point.reference,String(point.pixel),String(point.wavelength),point.predicted.toFixed(5),point.residual.toFixed(5)])row.append(node('td','',text));table.append(row);}
      $('wizard-residuals').append(table);
    }catch(error){$('wizard-fit-error').textContent=error.message;}
    $('wizard-finish').disabled=!this.result;
  }
  async finish(){
    this.renderReview();if(!this.result)return;
    try{
      await this.onApply({version:1,createdAt:new Date().toISOString(),coefficients:[...this.result.coefficients],degree:this.result.degree,rms:this.result.rms,settings:{...this.settings},framesPerAverage:this.frameCount,darkFrame:[...this.dark],references:structuredClone(this.references)});
      this.session++;this.dialog.close();
    }catch(error){this.error(error.message);}
  }
  async cancel(){
    this.session++;this.controller?.abort();this.controller=null;
    if(this.busy&&this.device.port)await this.device.disconnect();
    this.busy=false;this.dialog.close();
  }
}
