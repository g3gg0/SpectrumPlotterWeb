import {maximum, normalize, findPeaks} from './data.js';

export function wavelengthColor(wavelength, alpha=1) {
  let r=0,g=0,b=0;
  if(wavelength<380){r=.38;b=.6;}
  else if(wavelength<440){r=(440-wavelength)/60;b=1;}
  else if(wavelength<490){g=(wavelength-440)/50;b=1;}
  else if(wavelength<510){g=1;b=(510-wavelength)/20;}
  else if(wavelength<580){r=(wavelength-510)/70;g=1;}
  else if(wavelength<645){r=1;g=(645-wavelength)/65;}
  else {r=wavelength<780?1:.55;}
  return `rgba(${Math.round(r*215+32)},${Math.round(g*215+32)},${Math.round(b*215+32)},${alpha})`;
}
function niceTicks(min,max,target=7){
  const step0=(max-min)/target;
  const power=10**Math.floor(Math.log10(step0||1));
  const factor=step0/power;
  const step=(factor<1.5?1:factor<3?2:factor<7?5:10)*power;
  const ticks=[];
  for(let v=Math.ceil(min/step)*step;v<=max+step*1e-6&&ticks.length<100;v+=step)ticks.push(Math.abs(v)<1e-12?0:v);
  return ticks;
}
const number=v=>Math.abs(v)>=10000||(Math.abs(v)<.001&&v!==0)?v.toExponential(1):Number(v.toFixed(4)).toString();
function nearest(x,value){let lo=0,hi=x.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(x[m]>value)hi=m;else lo=m;}return Math.abs(x[lo]-value)<Math.abs(x[hi]-value)?lo:hi;}

export class SpectrumPlot {
  constructor(canvas,{tooltip,onCursor=()=>{},onRange=()=>{},onSelect=()=>{},xAxis='wavelength'}={}){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.tooltip=tooltip;this.onCursor=onCursor;this.onRange=onRange;
    this.onSelect=onSelect;this.xAxis=xAxis;this.markers=[];
    this.signal=null;this.captures=[];this.references=[];this.peaks=true;this.view=null;this.hover=null;this.drag=null;
    this.resize=new ResizeObserver(()=>this.schedule());this.resize.observe(canvas);
    canvas.addEventListener('wheel',e=>{e.preventDefault();const p=this.point(e);if(this.inside(p))this.zoom(Math.exp(Math.max(-1,Math.min(1,e.deltaY*.0015))),this.fromX(p.x));},{passive:false});
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      const p=this.point(e);if(!this.inside(p))return;
      this.drag={x:p.x,view:[...this.range()],select:e.shiftKey,current:p.x};canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove',e=>{
      const p=this.point(e);
      if(this.drag){
        if(this.drag.select)this.drag.current=p.x;
        else {const d=(p.x-this.drag.x)/this.area.w*(this.drag.view[1]-this.drag.view[0]);this.view=[this.drag.view[0]-d,this.drag.view[1]-d];}
      }
      this.hover=this.inside(p)?p:null;this.schedule();
    });
    const endDrag=e=>{
      if(!this.drag)return;
      const point=this.point(e),signal=this.signal;
      if(e.type!=='pointercancel'&&!this.drag.select&&this.inside(point)&&Math.abs(point.x-this.drag.x)<4&&signal){const index=nearest(signal.x,this.fromX(point.x));this.onSelect({x:signal.x[index],intensity:signal.y[index],index});}
      if(this.drag.select&&Math.abs(this.drag.current-this.drag.x)>6){const ends=[this.fromX(this.drag.x),this.fromX(this.drag.current)].sort((a,b)=>a-b);this.view=ends;this.onRange(ends);}
      this.drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);this.schedule();
    };
    canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
    canvas.addEventListener('pointerleave',()=>{if(!this.drag){this.hover=null;if(this.tooltip)this.tooltip.hidden=true;this.schedule();}});
    canvas.addEventListener('dblclick',()=>this.fit());
    canvas.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='='){e.preventDefault();this.zoom(.75);}if(e.key==='-'){e.preventDefault();this.zoom(1.25);}if(e.key==='Home'){e.preventDefault();this.fit();}});
  }
  point(e){const rect=this.canvas.getBoundingClientRect();return{x:e.clientX-rect.left,y:e.clientY-rect.top};}
  inside(p){return this.area&&p.x>=this.area.x&&p.x<=this.area.x+this.area.w&&p.y>=this.area.y&&p.y<=this.area.y+this.area.h;}
  range(){if(this.view)return this.view;const all=[this.signal,...this.captures,...this.references].filter(s=>s?.x.length);return all.length?[Math.min(...all.map(s=>s.x[0])),Math.max(...all.map(s=>s.x.at(-1)))]:[350,800];}
  fromX(pixel){const [lo,hi]=this.range();return lo+(pixel-this.area.x)/this.area.w*(hi-lo);}
  zoom(factor,anchor){const [lo,hi]=this.range();const center=anchor??(lo+hi)/2;const span=(hi-lo)*factor;if(span<.01||span>1000000)return;this.view=[center+(lo-center)*factor,center+(hi-center)*factor];this.schedule();}
  fit(){this.view=null;this.hover=null;this.schedule();}
  setData({signal=this.signal,captures=this.captures,references=this.references,unit=this.unit}={}){Object.assign(this,{signal,captures,references,unit});this.schedule();}
  schedule(){if(this.pending)return;this.pending=true;requestAnimationFrame(()=>{this.pending=false;this.draw();});}
  draw(){
    const c=this.canvas,ctx=this.ctx,rect=c.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    if(rect.width<1||rect.height<1)return;
    const w=rect.width,h=rect.height;c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#181c22';ctx.fillRect(0,0,w,h);
    const area=this.area={x:62,y:24,w:w-113,h:h-84};
    const [xmin,xmax]=this.range();
    let ymin=0,ymax=0;
    for(const s of [this.signal,...this.captures].filter(Boolean))for(let i=0;i<s.x.length;i++)if(s.x[i]>=xmin&&s.x[i]<=xmax){ymin=Math.min(ymin,s.y[i]);ymax=Math.max(ymax,s.y[i]);}
    if(ymax===ymin)ymax=ymin+1;
    const baseMax=ymax;
    ymax+=(ymax-ymin)*.16;ymin-=(ymax-ymin)*.025;
    this.yRange=[ymin,ymax];
    const X=x=>area.x+(x-xmin)/(xmax-xmin)*area.w,Y=y=>area.y+area.h-(y-ymin)/(ymax-ymin)*area.h;
    this.X=X;this.Y=Y;
    ctx.font='9px Consolas, monospace';ctx.lineWidth=1;ctx.fillStyle='#74808e';
    for(const v of niceTicks(xmin,xmax,Math.max(3,area.w/95))){const x=X(v);ctx.strokeStyle='#2a3039';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(x,area.y);ctx.lineTo(x,area.y+area.h);ctx.stroke();ctx.setLineDash([]);ctx.textAlign='center';ctx.fillText(number(v),x,area.y+area.h+27);}
    for(const v of niceTicks(ymin,ymax,5)){const y=Y(v);ctx.strokeStyle='#2a3039';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(area.x,y);ctx.lineTo(area.x+area.w,y);ctx.stroke();ctx.setLineDash([]);ctx.textAlign='right';ctx.fillStyle='#74808e';ctx.fillText(number(v),area.x-12,y+3);}
    ctx.strokeStyle='#3b444f';ctx.beginPath();ctx.moveTo(area.x,area.y);ctx.lineTo(area.x,area.y+area.h);ctx.lineTo(area.x+area.w,area.y+area.h);ctx.stroke();
    for(let x=0;x<area.w;x++){ctx.fillStyle=this.xAxis==='pixel'?'#526171':wavelengthColor(xmin+x/area.w*(xmax-xmin),.65);ctx.fillRect(area.x+x,area.y+area.h+5,1,3);}
    ctx.textAlign='center';ctx.fillStyle='#82909f';ctx.font='10px "Segoe UI",sans-serif';ctx.fillText(this.xAxis==='pixel'?'Detektorpixel (0–3693)':'Wavelength (nm)',area.x+area.w/2,h-12);
    ctx.save();ctx.translate(15,area.y+area.h/2);ctx.rotate(-Math.PI/2);ctx.fillText(this.unit||'Relative intensity (a.u.)',0,0);ctx.restore();
    if(this.references.length){ctx.fillStyle='#847ba2';ctx.font='8px Consolas,monospace';ctx.textAlign='left';ctx.fillText('REF.',area.x+area.w+10,area.y-7);for(const v of [0,.25,.5,.75,1])ctx.fillText(v.toFixed(2),area.x+area.w+10,Y(v*baseMax)+3);}
    ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
    const trace=(s,color,width,fill=false,relative=false)=>{
      if(!s?.x.length)return;
      const yy=relative?normalize(s.y).map(v=>v*baseMax):s.y;
      ctx.beginPath();let first=true,firstX=0,lastX=0;
      for(let i=0;i<s.x.length;i++){
        if(s.x[i]<xmin-(xmax-xmin)*.01||s.x[i]>xmax+(xmax-xmin)*.01)continue;
        const px=X(s.x[i]),py=Y(yy[i]);if(first){ctx.moveTo(px,py);firstX=px;first=false;}else ctx.lineTo(px,py);lastX=px;
      }
      if(first)return;
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.stroke();
      if(fill){ctx.lineTo(lastX,Y(0));ctx.lineTo(firstX,Y(0));ctx.closePath();const fade=ctx.createLinearGradient(0,area.y,0,area.y+area.h);fade.addColorStop(0,'#75cbd52b');fade.addColorStop(1,'#75cbd500');ctx.fillStyle=fade;ctx.fill();}
    };
    for(const reference of this.references)trace(reference,reference.color,1.1,false,true);
    for(const capture of this.captures)trace(capture,capture.color,1.1);
    if(this.signal)trace(this.signal,'#7acbd4',1.5,true);
    for(const marker of this.markers){if(marker.x<xmin||marker.x>xmax)continue;const px=X(marker.x);ctx.strokeStyle=marker.color||'#e7c28b';ctx.setLineDash([4,4]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px,area.y);ctx.lineTo(px,area.y+area.h);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=marker.color||'#e7c28b';ctx.font='10px Consolas,monospace';ctx.textAlign='center';ctx.fillText(marker.label||'',px,area.y+12);}
    if(this.drag?.select){const left=Math.min(this.drag.x,this.drag.current);ctx.fillStyle='#e7c28b20';ctx.fillRect(left,area.y,Math.abs(this.drag.x-this.drag.current),area.h);ctx.strokeStyle='#e7c28b';ctx.strokeRect(left,area.y,Math.abs(this.drag.x-this.drag.current),area.h);}
    ctx.restore();
    if(this.peaks&&this.signal){
      const selected=findPeaks(this.signal,8).filter(p=>p.x>xmin&&p.x<xmax).slice(0,5).sort((a,b)=>a.x-b.x);let lastLabel=-100;
      for(const peak of selected){const px=X(peak.x),py=Y(peak.y);if(px-lastLabel<53)continue;lastLabel=px;
        ctx.fillStyle='#e6c699';ctx.beginPath();ctx.arc(px,py,2.4,0,Math.PI*2);ctx.fill();ctx.font='9px Consolas,monospace';ctx.textAlign='center';ctx.fillText(peak.x.toFixed(1),px,Math.max(area.y+10,py-14));ctx.strokeStyle='#8b795b';ctx.beginPath();ctx.moveTo(px,py-4);ctx.lineTo(px,py-9);ctx.stroke();
      }
    }
    if(this.hover&&!this.drag){
      const wavelength=this.fromX(this.hover.x),signal=this.signal||this.references[0]||this.captures[0];
      ctx.setLineDash([3,4]);ctx.strokeStyle='#6b7889';ctx.beginPath();ctx.moveTo(this.hover.x,area.y);ctx.lineTo(this.hover.x,area.y+area.h);ctx.moveTo(area.x,this.hover.y);ctx.lineTo(area.x+area.w,this.hover.y);ctx.stroke();ctx.setLineDash([]);
      if(signal){const index=nearest(signal.x,wavelength);const intensity=signal.y[index];const yy=this.signal||this.captures.includes(signal)?intensity:normalize(signal.y)[index]*baseMax;
        ctx.fillStyle='#dcecf1';ctx.beginPath();ctx.arc(X(signal.x[index]),Y(yy),3,0,Math.PI*2);ctx.fill();
        this.onCursor({wavelength:signal.x[index],intensity});
        if(this.tooltip){this.tooltip.textContent=`${this.xAxis==='pixel'?'Pixel':'λ'}  ${signal.x[index].toFixed(this.xAxis==='pixel'?0:3)}${this.xAxis==='pixel'?'':' nm'}\nI  ${number(intensity)}`;this.tooltip.hidden=false;this.tooltip.style.left=`${Math.max(0,Math.min(w-155,this.hover.x+15))}px`;this.tooltip.style.top=`${Math.max(0,Math.min(h-60,this.hover.y-55))}px`;}
      }
    }else if(this.tooltip)this.tooltip.hidden=true;
  }
  png(){this.hover=null;this.draw();return this.canvas.toDataURL('image/png');}
}

export function sparkline(canvas,values,color){
  const ctx=canvas.getContext('2d'),w=canvas.clientWidth||120,h=27,dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=w*dpr;canvas.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
  const max=maximum(values)||1;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();
  // Preserve narrow emission peaks when reducing thousands of samples to a tiny signature.
  for(let i=0;i<Math.floor(w);i++){const start=Math.floor(i*values.length/w),end=Math.max(start+1,Math.floor((i+1)*values.length/w));let peak=0;for(let j=start;j<end&&j<values.length;j++)peak=Math.max(peak,values[j]);const py=h-3-peak/max*(h-6);if(!i)ctx.moveTo(i,py);else ctx.lineTo(i,py);}
  ctx.stroke();
}
