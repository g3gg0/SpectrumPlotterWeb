import {Spectrometer,timing,BAUD_RATE,PIXELS} from './protocol.js';
import {DEFAULTS,COLORS,id,maximum,normalize,parseLibrary,parseCapture,exportCapture,parseConfig,correct,interpolate,match,findPeaks,fitPolynomial,demoData} from './data.js';
import {SpectrumPlot,sparkline} from './plot.js';
import {loadWorkspace,saveWorkspace} from './storage.js';
import {buildSummary,buildDate,deviceInfoRows} from './device-info.js';
import {adcStatistics,readAdcStatistics,adcPresentation} from './adc.js';
import {CalibrationWizard} from './calibration-wizard.js';
import {makeProfile,validateProfile,saveCalibrationProfile,loadCalibrationProfile} from './calibration-profile.js';
import {setupFirmwareUpdate} from './firmware-update.js';

const $=selector=>document.querySelector(selector);
const make=(tag,className='',text='')=>{const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
const icon=(name)=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href',`#i-${name}`);svg.append(use);return svg;};
function action(name,title,callback){const button=make('button','icon-button');button.type='button';button.title=title;button.setAttribute('aria-label',title);button.append(icon(name));button.addEventListener('click',callback);return button;}
const state={config:structuredClone(DEFAULTS),references:[],captures:[],darkFrame:[],calibration:null,profile:null,raw:null,signal:null,frames:0,status:'disconnected',lastFrame:0,log:[],sortScore:true,ready:false};
let saveTimer,matchTimer,renderTimer,storeWarning=false,connectionBusy=false,previousAdcStatus=null;

function log(message,level='info'){
  const entry={time:new Date(),message,level};state.log.push(entry);state.log=state.log.slice(-80);
  $('#last-log').textContent=message;
  const li=make('li',level);const time=make('time','',entry.time.toLocaleTimeString());li.append(time,document.createTextNode(message));
  $('#log-entries').append(li);while($('#log-entries').children.length>80)$('#log-entries').firstChild.remove();
  $('#log-entries').scrollTop=$('#log-entries').scrollHeight;
}
function toast(message,error=false){
  const item=make('div',`toast${error?' error':''}`);item.append(make('span','',message));const dismiss=make('button','','×');dismiss.setAttribute('aria-label','Dismiss notification');dismiss.onclick=()=>item.remove();item.append(dismiss);$('#toast-stack').append(item);setTimeout(()=>item.remove(),error?12000:5000);
}
function report(error){if(error.name==='AbortError')return;log(error.message,'error');toast(error.message,true);if($('#settings-dialog').open){$('#calibration-io-message').textContent=error.message;$('#calibration-io-message').hidden=false;}}
function save(){
  if(!state.ready)return;
  clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{
    try{await saveWorkspace({config:state.config,references:state.references.filter(r=>!r.demo),captures:state.captures,darkFrame:Array.from(state.darkFrame),calibration:state.calibration});}
    catch(error){if(!storeWarning){storeWarning=true;log(`Local storage unavailable: ${error.message}`,'error');toast('Browser storage is unavailable or full. Export important captures before closing.',true);}}
  },350);
}
function download(name,content,type='application/json'){
  const url=URL.createObjectURL(new Blob([content],{type}));const link=make('a');link.href=url;link.download=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function jsonDownload(name,data){download(name,JSON.stringify(data,null,2));}
function clearDemo(){
  if(state.signal?.source==='demo')state.signal=null;
  state.references=state.references.filter(r=>!r.demo);
}
function displayed(){
  if(state.signal)return state.signal;
  const capture=state.captures.find(c=>c.visible);if(capture)return capture;
  const reference=state.references.find(r=>r.visible);
  return reference?{...reference,y:normalize(reference.y),source:'reference'}:null;
}
function unit(){
  const signal=displayed();
  if(['reference','demo'].includes(signal?.source))return 'Relative intensity (a.u.)';
  const normalized=signal?.metadata?.normalized??state.config.normalize;
  const units=signal?.metadata?.units??state.config.units;
  const calibrated=signal?.metadata?.amplitudeCalibrated??Boolean(state.config.amplitude&&state.config.amplitudeEnabled);
  return normalized?'Relative intensity (a.u.)':units==='counts'?(calibrated?'Intensity (corrected counts)':'Intensity (ADC counts)'):'Relative intensity (a.u.)';
}
function updatePlot(fit=false){
  plot.setData({signal:state.signal,captures:state.captures.filter(c=>c.visible),references:state.references.filter(r=>r.visible),unit:state.signal?.source==='demo'?'Relative intensity (a.u.)':unit()});
  if(fit)plot.fit();
  renderMetrics();renderLegend();
  const signal=displayed();const source=signal?.source;
  const label=source==='demo'?'Synthetic demo':source==='device'?'Live acquisition':source==='calibration'?'Calibration reference':source==='import'?'Imported capture':source==='capture'?'Saved capture':signal?'Reference spectrum':'No spectrum';
  const badge=$('#source-badge');badge.textContent=label;badge.className=`badge ${source==='device'?'live-badge':source==='demo'?'demo-badge':''}`;
  $('#capture-button').disabled=!signal;$('#empty-capture').disabled=!signal;$('#csv-button').disabled=!signal;
}
const plot=new SpectrumPlot($('#spectrum-canvas'),{tooltip:$('#plot-tooltip'),onCursor:({wavelength,intensity})=>{$('#cursor-readout').textContent=`λ ${wavelength.toFixed(3)} nm · I ${intensity.toPrecision(5)}`;}});

function renderMetrics(){
  const signal=displayed();
  if(signal){
    let peak=0;for(let i=1;i<signal.y.length;i++)if(signal.y[i]>signal.y[peak])peak=i;
    $('#metric-peak').textContent=signal.x[peak].toFixed(2);
    $('#metric-intensity').textContent=signal.y[peak]>=100?signal.y[peak].toFixed(0):signal.y[peak].toPrecision(3);
    $('#metric-unit').textContent=unit().includes('counts')?'counts':'a.u.';
    $('#metric-range').textContent=`${signal.x[0].toFixed(0)}–${signal.x.at(-1).toFixed(0)}`;
  }else for(const name of ['peak','intensity','range'])$(`#metric-${name}`).textContent='—';
  $('#metric-frames').textContent=state.frames.toLocaleString();
  renderAdc(signal);
}
function renderAdc(signal){
  const stats=readAdcStatistics(signal?.metadata?.adc),presentation=adcPresentation(stats);
  const indicator=$('#adc-indicator');indicator.dataset.status=presentation.status;
  $('#adc-utilization').textContent=presentation.usage;$('#adc-counts').textContent=presentation.counts;
  $('#adc-level').textContent=presentation.label;
  const percent=stats?.utilizationPercent;
  $('#adc-meter-fill').style.width=`${percent===null||percent===undefined?(stats?.invalidSamples?100:0):Math.max(0,Math.min(100,percent))}%`;
  const meter=$('#adc-meter');
  if(percent===null||percent===undefined)meter.removeAttribute('aria-valuenow');else meter.setAttribute('aria-valuenow',String(percent));
  meter.setAttribute('aria-valuetext',`${presentation.usage}; ${presentation.counts}; ${presentation.label}`);
  const averaged=Boolean(stats&&signal?.metadata?.averages>1);
  indicator.title=stats?`Peak of transmitted ADC samples${signal?.metadata?.hostAverages?` across ${signal.metadata.hostAverages} individual frames before software averaging`:''} before dark subtraction, calibration, resampling and normalization. Low: <5% FS; near limit: ≥95% FS; saturated: any sample =4095. Minimum: ${stats.minimum}; clipped: ${stats.clippedSamples}/${stats.sampleCount}.${averaged?' Hardware averaging can hide clipping of individual integrations.':''}`:'Exposure cannot be inferred from normalized spectra or references without recorded ADC statistics.';
  $('#adc-averaging-note').hidden=!averaged;
  const isError=Boolean(presentation.error);$('#intensity-card').classList.toggle('adc-fault',isError);
  $('.plot-panel').classList.toggle('adc-fault',isError);
  const banner=$('#adc-error');banner.hidden=!isError;
  const title=presentation.status==='saturated'?'ERROR · ADC SATURATED':'ERROR · INVALID ADC DATA';
  if($('#adc-error-title').textContent!==title)$('#adc-error-title').textContent=title;
  const message=presentation.error||'';
  if($('#adc-error-message').textContent!==message)$('#adc-error-message').textContent=message;
}
function renderLegend(){
  const legend=$('#plot-legend');legend.replaceChildren();
  const items=[];if(state.signal)items.push({name:state.signal.source==='demo'?'Synthetic measurement':state.signal.source==='calibration'?state.signal.name:'Measurement',color:'#7acbd4'});
  for(const capture of state.captures.filter(c=>c.visible))items.push(capture);
  for(const reference of state.references.filter(r=>r.visible))items.push({...reference,name:`${reference.name} · reference`});
  if(!items.length){legend.append(make('span','muted','Connect a spectrometer or import reference files'));return;}
  for(const item of items){const label=make('span','legend-item');label.title=item.name;const dot=make('i','legend-dot');dot.style.backgroundColor=item.color;label.append(dot,document.createTextNode(item.name));legend.append(label);}
}
function renderReferences(){
  const search=$('#reference-search').value.toLowerCase();const rows=$('#reference-rows');rows.replaceChildren();
  const references=state.references.filter(r=>`${r.name} ${r.group}`.toLowerCase().includes(search));
  references.sort(state.sortScore?(a,b)=>(b.score??-Infinity)-(a.score??-Infinity)||a.name.localeCompare(b.name):(a,b)=>a.name.localeCompare(b.name));
  $('#library-count').textContent=state.references.length;$('#library-empty').hidden=state.references.length>0;
  $('#reference-summary').textContent=state.references.some(r=>r.demo)?'Synthetic examples · import your LIBS files':`${state.references.filter(r=>r.visible).length} visible · ${new Set(state.references.map(r=>r.group)).size} libraries`;
  if(state.references.length&&!references.length)rows.append(make('div','empty-state','No matching species. Try a different search.'));
  for(const ref of references){
    const row=make('div','reference-row');
    const label=make('label','reference-species');const check=make('input');check.type='checkbox';check.checked=ref.visible;check.style.accentColor=ref.color;check.setAttribute('aria-label',`Overlay ${ref.name}`);
    check.addEventListener('change',()=>{ref.visible=check.checked;updatePlot(!state.signal&&!state.captures.some(c=>c.visible));save();renderReferences();});
    const title=make('span');const name=make('span','reference-name',ref.name);name.style.color=ref.visible?ref.color:'';name.title=ref.name;
    title.append(name,make('span','reference-source',ref.demo?'SYNTHETIC EXAMPLE':ref.group));label.append(check,title);
    const canvas=make('canvas','sparkline');canvas.setAttribute('aria-label',`${ref.name} spectral signature`);
    const score=make('div',`match-value${ref.score>=70?' good':''}`,ref.score===null||ref.score===undefined?'—':`${ref.score.toFixed(1)}%`);
    if(ref.score!==null&&ref.score!==undefined){const track=make('span','match-track'),fill=make('i','match-fill');fill.style.width=`${Math.max(0,Math.min(100,ref.score))}%`;track.append(fill);score.append(track);}
    const remove=action('close',`Remove ${ref.name}`,()=>{state.references=state.references.filter(r=>r.id!==ref.id);renderReferences();updatePlot();save();});
    row.append(label,canvas,score,remove);rows.append(row);sparkline(canvas,ref.y,ref.color);
  }
}
function renderCaptures(){
  const rows=$('#capture-rows');rows.replaceChildren();$('#capture-count').textContent=state.captures.length;$('#captures-empty').hidden=state.captures.length>0;
  $('#clear-captures').disabled=!state.captures.length;
  for(const capture of [...state.captures].reverse()){
    const row=make('div','capture-row');const check=make('input');check.type='checkbox';check.checked=capture.visible;check.style.accentColor=capture.color;check.setAttribute('aria-label',`Show ${capture.name}`);
    check.onchange=()=>{capture.visible=check.checked;updatePlot();save();};
    const color=make('input');color.type='color';color.value=capture.color;color.title='Capture color';color.setAttribute('aria-label',`Color for ${capture.name}`);color.oninput=()=>{capture.color=color.value;check.style.accentColor=color.value;updatePlot();save();};
    const content=make('div','capture-content');const name=make('input','capture-name');name.value=capture.name;name.maxLength=120;name.setAttribute('aria-label','Capture name');name.onchange=()=>{capture.name=name.value.trim()||'Untitled spectrum';updatePlot();save();};
    const when=capture.time&&!Number.isNaN(Date.parse(capture.time))?new Date(capture.time).toLocaleTimeString():'Imported';
    const annotation=capture.score===null||capture.score===undefined?'':` · ${capture.score.toFixed(1)}%`;
    content.append(name,make('small','',`${when} · ${capture.x.length.toLocaleString()} samples${capture.metadata?.source==='demo'?' · DEMO':''}${annotation}`));
    row.append(check,color,content,action('download',`Export ${capture.name}`,()=>jsonDownload(`${capture.name}.spect`,exportCapture(capture))),action('trash',`Remove ${capture.name}`,()=>{state.captures=state.captures.filter(c=>c.id!==capture.id);renderCaptures();updatePlot();save();}));rows.append(row);
  }
}
function captureCurrent(automatic=false){
  const signal=displayed();if(!signal){toast('There is no spectrum to capture yet.');return;}
  if(automatic&&state.config.autoClear)state.captures=state.captures.filter(c=>!c.automatic);
  if(state.captures.length>=100){toast('The workspace holds 100 captures. Export and remove captures to make room.',true);return;}
  const now=new Date();state.captures.push({id:id(),name:`${signal.source==='demo'?'Demo':'Capture'} ${now.toLocaleTimeString()}`,x:[...signal.x],y:[...signal.y],color:COLORS[state.captures.length%COLORS.length],visible:true,time:now.toISOString(),source:'capture',automatic,score:null,metadata:{source:signal.source||'reference',...signal.metadata,normalized:state.config.normalize,units:state.config.units,lambda:[...state.config.lambda]}});
  renderCaptures();updatePlot();save();if(!automatic)toast('Spectrum saved to captures.');
}
function calculateMatches(announce=false){
  const signal=displayed();if(!signal){if(announce)toast('Acquire or import a spectrum first.');return;}
  const start=performance.now();
  for(const reference of state.references)reference.score=match(signal.y,interpolate(reference,signal.x),state.config.matchMethod);
  for(const capture of state.captures)capture.score=match(signal.y,interpolate(capture,signal.x),state.config.matchMethod);
  renderReferences();renderCaptures();
  if(announce)log(`Compared ${state.references.length} reference species using ${state.config.matchMethod} (${(performance.now()-start).toFixed(0)} ms). Scores are similarities, not probabilities.`);
}
function scheduleMatching(){clearTimeout(matchTimer);matchTimer=setTimeout(()=>calculateMatches(),80);}
function reprocess(){
  if(state.raw){try{const data=correct(state.raw,state.config,state.darkFrame);state.signal={...state.signal,...data,metadata:{...state.signal?.metadata,amplitudeCalibrated:Boolean(state.config.amplitude&&state.config.amplitudeEnabled)}};}catch(error){report(error);}}
  else if(state.signal?.source==='demo'){const demo=demoData();state.signal={...demo.signal,y:state.config.normalize?normalize(demo.signal.y):demo.signal.y};}
  updatePlot();scheduleMatching();save();
}
function renderConfig(){
  if(!Array.from($('#resample').options).some(option=>Number(option.value)===state.config.resample)){
    const option=make('option','',`Custom · ${state.config.resample.toLocaleString()} samples`);option.value=state.config.resample;$('#resample').append(option);
  }
  for(const [selector,key] of [['#sh-us','shUs'],['#icg-us','icgUs'],['#delay-us','delayUs'],['#averages','averages'],['#resample','resample'],['#match-method','matchMethod']])$(selector).value=state.config[key];
  for(const [selector,key] of [['#normalize','normalize'],['#auto-match','autoMatch'],['#auto-capture','autoCapture'],['#auto-clear','autoClear']])$(selector).checked=state.config[key];
  for(const [selector,active]of [['#mode-live',!state.config.triggered],['#mode-trigger',state.config.triggered]]){$(selector).classList.toggle('active',active);$(selector).setAttribute('aria-pressed',String(active));}
  $('#delay-us').disabled=!state.config.triggered;$('#delay-us').closest('.number-field').classList.toggle('disabled-field',!state.config.triggered);
  $('#mode-hint').textContent=state.config.triggered?'PC13 · falling edge. Rearms after every complete frame.':'Repeated single shots. Settings use actual microseconds.';
  $('#dark-status').textContent=state.darkFrame.length?'Dunkelbild aktiv · 3.694 Pixel':'Noch kein Dunkelbild';
  $('#amplitude-sidebar-status').textContent=state.config.amplitude?(state.config.amplitudeEnabled?'Relative Amplitude aktiv':'Amplitude deaktiviert'):'Amplitude nicht angelernt';
}
function acquisitionConfig(){
  const config=timing(state.config);
  if(config.shUs!==state.config.shUs||config.icgUs!==state.config.icgUs){state.config.shUs=config.shUs;state.config.icgUs=config.icgUs;renderConfig();save();log(`Timing aligned to the 2 MHz clock: SH ${config.shUs} µs, ICG ${config.icgUs} µs.`);}
  return config;
}
function renderConnection(status,details){
  state.status=status;
  const connected=device.verified;
  const busy=['acquiring','armed','receiving','finishing'].includes(status);
  $('#acquisition-fields').disabled=busy||status==='connecting';
  $('#connect-button').replaceChildren(icon('connect'),document.createTextNode(connected?'Disconnect':status==='connecting'?'Verifying…':'Connect'));
  $('#connect-button').disabled=connectionBusy||status==='connecting';
  const badge=$('#connection-badge');badge.className=`badge${connected?' connected':''}`;
  const badgeCopy=make('span','badge-copy');badgeCopy.append(make('span','',connected?'Device verified':status==='connecting'?'Identifying device':'Not connected'));
  if(connected)badgeCopy.append(make('small','badge-build',buildSummary(device.buildInfo)));
  badge.replaceChildren(make('span','status-dot'),badgeCopy);badge.disabled=!connected;
  badge.title=connected?`${buildSummary(device.buildInfo)}\nBuilt: ${buildDate(device.buildInfo)}\nClick for full device information`:'Connect an instrument to view firmware information';
  const descriptions={disconnected:'Ready when you are',connecting:'Checking firmware identity…',ready:'Connected · acquisition paused',acquiring:'Acquiring spectrum…',armed:'Armed · waiting for PC13 ↓',receiving:'Receiving spectrum…',finishing:'Pausing after this frame…'};
  const indicator=$('#acquisition-state');indicator.className=`acquisition-state${status==='armed'?' armed':busy?' active':''}`;indicator.lastElementChild.textContent=descriptions[status]||status;
  $('#device-dot').style.backgroundColor=connected?'var(--green)':'';
  $('#run-button').disabled=!connected||status==='finishing';
  $('#run-button').replaceChildren(icon(busy?'pause':'play'),document.createTextNode(status==='finishing'?'Finishing…':busy?(state.config.triggered?'Stop & disconnect':'Pause acquisition'):state.config.triggered?'Arm trigger':'Start acquisition'));
  $('#single-button').disabled=!connected||busy;
  if(status==='ready'&&details){
    const vid=details.usbVendorId?.toString(16).padStart(4,'0')||'----',pid=details.usbProductId?.toString(16).padStart(4,'0')||'----';
    $('#device-name').textContent='TCD1304 · advanced';$('#device-detail').textContent=`${BAUD_RATE/1000} kbaud · ${vid}:${pid}`;
    renderDeviceInfo(details);
    log(`Verified tcd1304-advanced [g3gg0.de] at 500000 baud, 8N1. ${buildSummary(device.buildInfo)}. Built: ${buildDate(device.buildInfo)}.`);
  }
  if(status==='disconnected'){
    previousAdcStatus=null;
    $('#device-name').textContent='TCD1304';$('#device-detail').textContent='Connect to verify device';
    $('#device-build-summary').hidden=true;$('#device-build-summary').replaceChildren();$('#device-info-rows').replaceChildren();
    if($('#device-info-dialog').open)$('#device-info-dialog').close();
    if(state.frames)$('#metric-rate').textContent='Device disconnected';
  }
}
function renderDeviceInfo(details){
  const info=device.buildInfo,summary=$('#device-build-summary');summary.replaceChildren();summary.hidden=false;
  if(info){
    const build=make('div','firmware-summary-row');build.append(make('span','','Built'),make('time','mono',buildDate(info)));summary.append(build);
    const revision=make('div','firmware-summary-row');revision.append(make('span','','Commit'),make('code','',`${info.commit?.slice(0,12)||'Unavailable'}${info.dirty===true?' · dirty':''}`));summary.append(revision);
  }else summary.append(make('p','muted','Legacy firmware does not report build metadata.'));
  const more=make('button','text-button','Firmware & build details ↗');more.onclick=()=>$('#device-info-dialog').showModal();summary.append(more);
  $('#device-info-description').textContent=info?'Reported by the connected firmware. The working-tree state refers to the source at build time.':'Device identity verified. This firmware predates the build-information extension; its date and Git revision are unavailable.';
  const rows=$('#device-info-rows');rows.replaceChildren();
  for(const [name,value]of deviceInfoRows(info,details))rows.append(make('dt','',name),make('dd',name==='Commit'?'mono':'',value));
}
$('#connection-badge').onclick=()=>{if(device.verified)$('#device-info-dialog').showModal();};
$('#close-device-info').onclick=()=>$('#device-info-dialog').close();
$('#device-info-dialog').addEventListener('click',e=>{if(e.target===$('#device-info-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
const device=new Spectrometer({onState:renderConnection,onError:report,onProgress:(received,total)=>{
  if(received&&state.status!=='finishing')renderConnection('receiving');
  $('#acquisition-state').title=received?`${received} / ${total} bytes`:'';
},onFrame:(raw,metadata)=>{
  const wasDemo=state.signal?.source==='demo';state.raw=raw;state.frames++;
  if(wasDemo)state.references=state.references.filter(r=>!r.demo);
  const adc=adcStatistics(raw);
  try{state.signal={...correct(raw,state.config,state.darkFrame),name:'Measurement',source:'device',time:metadata.time,metadata:{...metadata,adc,amplitudeCalibrated:Boolean(state.config.amplitude&&state.config.amplitudeEnabled)}};}catch(error){report(error);return;}
  if(adc.status!==previousAdcStatus){
    const presentation=adcPresentation(adc);
    if(presentation.error)log(presentation.error,'error');
    else if(previousAdcStatus==='saturated'||previousAdcStatus==='invalid')log('ADC error cleared in the latest frame.');
    previousAdcStatus=adc.status;
  }
  const now=performance.now(),interval=state.lastFrame?now-state.lastFrame:0;state.lastFrame=now;
  $('#metric-rate').textContent=interval?`${(1000/interval).toFixed(1)} frames/s`:'First frame received';
  updatePlot(wasDemo||state.frames===1);
  if(metadata.triggered&&state.config.autoCapture)captureCurrent(true);
  if(metadata.triggered&&state.config.autoMatch)scheduleMatching();
  if(state.frames===1||metadata.triggered)log(`Frame ${state.frames}: ${PIXELS} samples, ${metadata.averages} integration(s)${metadata.triggered?', external trigger':''}.`);
  if(wasDemo)renderReferences();
}});

async function connect({autoStart=true}={}){
  if(!state.ready){toast('Please wait for the saved workspace to load.');return;}
  if(device.port){await device.disconnect();log('Serial port closed.');return;}
  if(!('serial'in navigator)){toast('Use desktop Chrome with Web Serial enabled on localhost or HTTPS.',true);return;}
  connectionBusy=true;$('#connect-button').disabled=true;
  try{
    const port=await navigator.serial.requestPort();
    await device.connect(port);
    connectionBusy=false;
    if(autoStart)device.start(acquisitionConfig());
  }catch(error){
    if(error.name==='NotFoundError')log('Port selection cancelled.');
    else report(error.message.includes('timeout')?new Error('Device identity not received. Use tcd1304-advanced at 500000 baud. Sep19 and unknown devices cannot be identified by this probe.'):error);
  }finally{connectionBusy=false;renderConnection(state.status);}
}
$('#connect-button').onclick=connect;
setupFirmwareUpdate({disconnect:async()=>{if(device.port)await device.disconnect();},report,log});
$('#run-button').onclick=async()=>{
  if(device.task){if(state.config.triggered){await device.disconnect();log('Trigger wait cancelled in browser. Serial port closed.');}else device.pause();}
  else try{device.start(acquisitionConfig());}catch(error){report(error);}
};
$('#single-button').onclick=()=>{try{device.start(acquisitionConfig(),{single:true});}catch(error){report(error);}};
const calibrationWizard=new CalibrationWizard({device,getSettings:()=>state.config,connect:()=>connect({autoStart:false}),log,onApply:async result=>{
  const config={...state.config,lambda:[...result.coefficients],amplitude:result.amplitude||null,amplitudeEnabled:true,shUs:result.settings.shUs,icgUs:result.settings.icgUs};
  const reference=result.halogen?{...result.halogen,name:'Halogenreferenz'}:result.references.at(-1),raw=Float64Array.from(reference.average);
  const signal={...correct(raw,config,result.darkFrame),name:reference.name,source:'calibration',time:reference.metadata.time,metadata:{...reference.metadata,amplitudeCalibrated:Boolean(config.amplitude)}};
  const profile=saveCalibrationProfile(makeProfile(config,result.darkFrame,result));
  state.config=config;state.darkFrame=[...result.darkFrame];state.calibration=result;
  state.profile=profile;state.raw=raw;state.signal=signal;
  state.references=state.references.filter(reference=>!reference.demo);renderReferences();
  renderConfig();reprocess();plot.fit();
  log(`Kalibrierassistent abgeschlossen: ${result.references.length} Referenz(en), Grad ${result.degree}, RMS ${result.rms.toPrecision(4)} nm.`);
  toast('Kalibrierung lokal gespeichert: Wellenlänge, Dunkelbild'+(config.amplitude?' und relative Amplitude.':'.'));
}});
const launchWizard=()=>{if(!state.ready){toast('Please wait for the saved workspace to load.');return;}if($('#settings-dialog').open)$('#settings-dialog').close();calibrationWizard.open();};
$('#calibration-wizard-button').onclick=launchWizard;$('#settings-wizard-button').onclick=launchWizard;
for(const [selector,key]of [['#sh-us','shUs'],['#icg-us','icgUs'],['#delay-us','delayUs'],['#averages','averages']])$(selector).addEventListener('change',()=>{state.config[key]=Number($(selector).value);save();});
$('#mode-live').onclick=()=>{state.config.triggered=false;renderConfig();save();};
$('#mode-trigger').onclick=()=>{state.config.triggered=true;renderConfig();save();};
$('#normalize').onchange=()=>{state.config.normalize=$('#normalize').checked;reprocess();};
$('#resample').onchange=()=>{state.config.resample=Number($('#resample').value);reprocess();};
for(const [selector,key]of [['#auto-match','autoMatch'],['#auto-capture','autoCapture'],['#auto-clear','autoClear']])$(selector).onchange=()=>{state.config[key]=$(selector).checked;save();};
$('#match-method').onchange=()=>{state.config.matchMethod=$('#match-method').value;calculateMatches();save();};
$('#peaks-button').onclick=()=>{plot.peaks=!plot.peaks;$('#peaks-button').classList.toggle('active',plot.peaks);$('#peaks-button').setAttribute('aria-pressed',String(plot.peaks));plot.schedule();};
$('#fit-button').onclick=()=>plot.fit();$('#zoom-in').onclick=()=>plot.zoom(.7);$('#zoom-out').onclick=()=>plot.zoom(1.4);
$('#capture-button').onclick=()=>captureCurrent();$('#empty-capture').onclick=()=>captureCurrent();
$('#clear-captures').onclick=()=>{if(!state.captures.length||!confirm(`Remove all ${state.captures.length} locally saved captures?`))return;state.captures=[];renderCaptures();updatePlot();save();};
$('#match-button').onclick=()=>calculateMatches(true);
$('#sort-match').onclick=()=>{state.sortScore=!state.sortScore;$('#sort-match').textContent=state.sortScore?'MATCH ↓':'NAME ↑';renderReferences();};
$('#reference-search').oninput=()=>renderReferences();
$('#csv-button').onclick=()=>{const signal=displayed();if(signal)download('spectrum.csv','wavelength_nm,intensity\r\n'+signal.x.map((x,i)=>`${x},${signal.y[i]}`).join('\r\n'),'text/csv;charset=utf-8');};
$('#png-button').onclick=()=>{const link=make('a');link.download='spectrum.png';link.href=plot.png();link.click();};
$('#demo-button').onclick=()=>{
  if(device.port){toast('Disconnect the instrument before opening the demo.');return;}
  const demo=demoData();state.raw=null;state.signal={...demo.signal,y:state.config.normalize?normalize(demo.signal.y):demo.signal.y};state.references=[...state.references.filter(r=>!r.demo),...demo.references];
  renderReferences();updatePlot(true);calculateMatches();log('Synthetic demonstration loaded. These curves are not NIST reference data.');
};

function pickFiles(){if(!state.ready){toast('Please wait for the saved workspace to load.');return;}$('#file-input').click();}
for(const selector of ['#import-button','#library-import','#empty-import','#capture-import'])$(selector).onclick=pickFiles;
async function importFiles(files){
  if(!state.ready)return;
  if(calibrationWizard.active){toast('Den Kalibrierassistenten zuerst abschließen oder abbrechen.',true);return;}
  let imported=0,failed=0,changes=false;
  for(const file of files){
    try{
      if(file.size>64*1024*1024)throw new Error('File exceeds the 64 MB import limit');
      const object=JSON.parse(await file.text());
      if(Array.isArray(object.Elements)){
        const refs=parseLibrary(object,file.name);clearDemo();
        for(const ref of refs){state.references=state.references.filter(old=>!(old.group===ref.group&&old.name===ref.name));ref.color=COLORS[state.references.length%COLORS.length];state.references.push(ref);}
        if(!state.references.some(r=>r.visible))state.references[0].visible=true;
        imported+=refs.length;changes=true;log(`Imported ${file.name}: ${refs.length} species.`);
      }else if(object.Wavelengths&&object.Intensities){
        if(state.captures.length>=100)throw new Error('Capture limit reached (100)');
        const capture=parseCapture(object,file.name);clearDemo();capture.color=COLORS[state.captures.length%COLORS.length];state.captures.push(capture);imported++;changes=true;log(`Imported capture ${file.name}: ${capture.x.length} samples.`);
      }else if(object.format==='SpectrumPlotterWebCalibration'||object.LambdaMap||object.lambda){applyImportedConfig(object);imported++;}
      else throw new Error('Expected a LIBS library, .spect capture, or SensorConfig');
    }catch(error){failed++;log(`${file.name}: ${error.message}`,'error');toast(`${file.name}: ${error.message}`,true);}
  }
  if(changes){renderReferences();renderCaptures();updatePlot(!state.raw);calculateMatches();save();}
  if(imported)toast(`Imported ${imported} item${imported===1?'':'s'}${failed?`; ${failed} file(s) could not be read`:''}.`);
}
$('#file-input').onchange=async e=>{await importFiles(e.target.files);e.target.value='';};
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}});
document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true;}});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;importFiles(e.dataTransfer.files);});

function formatCoefficient(value){return value!==0&&Math.abs(value)<1e-6?value.toExponential(7):Number(value.toPrecision(12)).toString();}
function openSettings(){
  $('#calibration-io-message').hidden=true;
  const form=$('#settings-form');
  state.config.lambda.forEach((value,i)=>form.elements[`lambda${i}`].value=formatCoefficient(value));
  const amplitude=state.config.amplitude;
  $('#amplitude-enabled').checked=Boolean(amplitude)&&state.config.amplitudeEnabled;$('#amplitude-enabled').disabled=!amplitude;
  $('#amplitude-status').textContent=amplitude?`Relative Halogenkorrektur · ${amplitude.startNm.toFixed(1)}–${amplitude.endNm.toFixed(1)} nm · ${amplitude.options.model==='planck'?`Planck-Ziel ${amplitude.options.temperatureK} K`:'weiches S-Ziel'} · Glättung ${amplitude.options.smoothingNm} nm.`:'Noch nicht angelernt. Optional im Kalibrierassistenten eine Halogenreferenz aufnehmen.';
  $('#calibration-storage-status').textContent=state.profile?`Lokal gespeichert · ${state.profile.createdAt.replace('T',' ').replace('Z',' UTC')}`:'Kalibrierung wird lokal im Browser gespeichert.';
  $('#fit-result').textContent='';$('#settings-dialog').showModal();
  const points=state.profile?.wavelength.points||state.calibration?.references?.flatMap(r=>r.points)||[];
  $('#fit-points').value=points.map(point=>`${point.pixel}, ${point.wavelength}`).join('\n');
  if(state.profile?.wavelength.degree)$('#fit-degree').value=state.profile.wavelength.degree;
}
$('#settings-button').onclick=openSettings;$('#calibration-button').onclick=openSettings;$('#close-settings').onclick=()=>$('#settings-dialog').close();
$('#settings-dialog').addEventListener('click',e=>{if(e.target===$('#settings-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('#settings-form').onsubmit=e=>{
  e.preventDefault();
  try{
    const next={...state.config,units:'counts',amplitudeEnabled:$('#amplitude-enabled').checked};
    next.lambda=Array.from({length:4},(_,i)=>Number(e.target.elements[`lambda${i}`].value));
    const changed=next.lambda.some((value,i)=>Math.abs(value-state.config.lambda[i])>Math.max(1e-15,Math.abs(value)*1e-10));
    if(changed)next.amplitude=null;
    parseConfig(next);
    // Validate the entire detector mapping before applying it to the live graph.
    correct(state.raw||new Uint16Array(PIXELS),next,state.darkFrame);
    const profile=saveCalibrationProfile(makeProfile(next,state.darkFrame,changed?{acquisition:state.profile?.acquisition}:state.calibration||state.profile));
    state.profile=profile;state.config=next;if(changed)state.calibration=null;
    renderConfig();reprocess();plot.fit();$('#settings-dialog').close();log(changed?'Wellenlänge gespeichert. Relative Amplitude bei geänderter Wellenlänge bitte neu anlernen.':'Kalibrierung lokal gespeichert.');
  }catch(error){report(error);}
};
$('#fit-polynomial').onclick=()=>{
  try{
    const lines=$('#fit-points').value.trim().split(/\r?\n/).filter(line=>line.trim());
    const points=lines.map(line=>{const parts=line.trim().split(/[,;\s]+/).map(Number);if(parts.length!==2||!parts.every(Number.isFinite))throw new Error('Each calibration line needs a pixel and wavelength');if(parts[0]<0||parts[0]>=PIXELS)throw new Error('Calibration pixels must be between 0 and 3693');return parts;});
    const result=fitPolynomial(points,Number($('#fit-degree').value));
    result.coefficients.forEach((value,i)=>$('#settings-form').elements[`lambda${i}`].value=formatCoefficient(value));
    $('#fit-result').textContent=`RMS ${result.rms.toPrecision(3)} nm`;
  }catch(error){report(error);}
};
function applyImportedConfig(object){
  if(calibrationWizard.active)throw new Error('Den Kalibrierassistenten zuerst abschließen oder abbrechen.');
  if(device.running||device.task)throw new Error('Pause or disconnect acquisition before importing instrument settings');
  let config,darkFrame,profile;
  if(object.format==='SpectrumPlotterWebCalibration'){
    profile=validateProfile(object);config={...state.config,lambda:[...profile.wavelength.coefficients],amplitude:profile.amplitude,amplitudeEnabled:profile.amplitudeEnabled,...(profile.acquisition||{})};darkFrame=profile.darkFrame;
  }else{const parsed=parseConfig(object);config=parsed.config;darkFrame=parsed.darkFrame;profile=makeProfile(config,darkFrame);}
  correct(state.raw||new Uint16Array(PIXELS),config,darkFrame);profile=saveCalibrationProfile(profile);
  state.config=config;state.darkFrame=darkFrame;state.profile=profile;state.calibration=null;renderConfig();reprocess();log('Kalibrierung importiert und lokal gespeichert.');
  if($('#settings-dialog').open){$('#settings-dialog').close();openSettings();}
}
$('#import-config').onclick=()=>$('#config-input').click();
$('#config-input').onchange=async e=>{try{if(e.target.files[0]){if(e.target.files[0].size>8*1024*1024)throw new Error('Config exceeds the 8 MB limit');applyImportedConfig(JSON.parse(await e.target.files[0].text()));toast('Configuration imported.');}}catch(error){report(error);}finally{e.target.value='';}};
$('#export-config').onclick=()=>{
  try{jsonDownload('spectrum.calibration.json',makeProfile(state.config,state.darkFrame,state.calibration||state.profile));}catch(error){report(error);}
};
document.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.metaKey||e.altKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||document.querySelector('dialog[open]'))return;
  if(e.key.toLowerCase()==='f'){e.preventDefault();plot.fit();}
  if(e.key.toLowerCase()==='s'){e.preventDefault();captureCurrent();}
  if(e.code==='Space'&&device.verified&&e.target===document.body){e.preventDefault();$('#run-button').click();}
});
window.addEventListener('resize',()=>{clearTimeout(renderTimer);renderTimer=setTimeout(renderReferences,150);});
window.addEventListener('pagehide',()=>{if(device.port)device.disconnect();});

async function initialize(){
  let restoredWorkspace=false;
  try{
    const saved=await loadWorkspace();
    if(saved){
      restoredWorkspace=true;
      state.config=parseConfig(saved.config||{}).config;
      state.references=(saved.references||[]).filter(r=>!r.demo);state.captures=saved.captures||[];
      state.darkFrame=parseConfig({darkFrame:saved.darkFrame||[]}).darkFrame;
      state.calibration=saved.calibration||null;
      log(`Restored ${state.references.length} reference species and ${state.captures.length} captures from this browser.`);
    }
  }catch(error){log(`Could not restore local workspace: ${error.message}`,'error');}
  try{
    const profile=loadCalibrationProfile();
    if(profile){state.profile=profile;state.config={...state.config,lambda:profile.wavelength.coefficients,amplitude:profile.amplitude,amplitudeEnabled:profile.amplitudeEnabled,...(restoredWorkspace?{}:profile.acquisition||{})};state.darkFrame=profile.darkFrame;log('Kalibrierung aus Local Storage geladen.');}
    else if(state.darkFrame.length||state.calibration)state.profile=saveCalibrationProfile(makeProfile(state.config,state.darkFrame,state.calibration));
  }catch(error){log(`Kalibrierung konnte nicht aus Local Storage geladen werden: ${error.message}`,'error');toast('Lokale Kalibrierung konnte nicht geladen werden. Bitte Kalibrierdatei prüfen oder importieren.',true);}
  state.ready=true;
  if(!state.references.length&&!state.captures.length){const demo=demoData();state.signal={...demo.signal,y:state.config.normalize?normalize(demo.signal.y):demo.signal.y};state.references=demo.references;log('Synthetic demo loaded. Connect an instrument or import your local spectra.');}
  renderConfig();renderReferences();renderCaptures();renderConnection('disconnected');updatePlot(true);calculateMatches();
  if(!window.isSecureContext||!('serial'in navigator)){
    $('#support-banner').hidden=false;$('#support-banner').textContent='Instrument connection requires desktop Chrome and localhost or HTTPS. File import, plotting, and analysis still work here.';
    $('#connect-button').disabled=true;
  }
}
initialize();
