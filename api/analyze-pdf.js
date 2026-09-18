const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
const { createCanvas } = require('@napi-rs/canvas');

export const config = { api: { bodyParser: false } };

async function readBody(req, max=15*1024*1024){
  const chunks=[]; let total=0;
  for await (const c of req){ total+=c.length; if(total>max) throw new Error('Archivo demasiado grande (máximo 15 MB).'); chunks.push(c); }
  return Buffer.concat(chunks);
}
function classify(data){
  let colorful=0, dark=0, sampled=0;
  const step=16; // sample pixels for speed
  for(let i=0;i<data.length;i+=4*step){
    const r=data[i],g=data[i+1],b=data[i+2],a=data[i+3]; if(a<20) continue;
    sampled++;
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    const chroma=max-min;
    const lum=(r+g+b)/3;
    if(chroma>18 && max>45) colorful++;
    if(lum<225) dark++;
  }
  const colorRatio=sampled?colorful/sampled:0;
  const inkRatio=sampled?dark/sampled:0;
  // Heuristic: tiny color marks/logos stay B/N; moderate color = school; photo-heavy = full.
  const type=colorRatio<0.012?'bn':(colorRatio<0.20 && inkRatio<0.48?'school':'full');
  return {type,colorRatio:+(colorRatio*100).toFixed(1),inkRatio:+(inkRatio*100).toFixed(1)};
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Usa POST.'});
  try{
    const body=await readBody(req);
    const contentType=req.headers['content-type']||'';
    let pdf=body;
    if(contentType.includes('multipart/form-data')){
      const boundary='--'+contentType.split('boundary=')[1];
      const bin=body.toString('binary');
      const start=bin.indexOf('\r\n\r\n')+4;
      const end=bin.lastIndexOf('\r\n'+boundary);
      pdf=Buffer.from(bin.slice(start,end),'binary');
    }
    if(pdf.slice(0,5).toString()!=='%PDF-') throw new Error('El archivo no parece ser un PDF válido.');
    const doc=await pdfjsLib.getDocument({data:new Uint8Array(pdf),disableWorker:true}).promise;
    if(doc.numPages>150) throw new Error('Máximo 150 páginas por análisis.');
    const pages=[]; const counts={bn:0,school:0,full:0};
    for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n);
      const viewport=page.getViewport({scale:0.55});
      const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      const result=classify(ctx.getImageData(0,0,canvas.width,canvas.height).data);
      counts[result.type]++;
      pages.push({page:n,...result});
    }
    res.status(200).json({pages:doc.numPages,counts,details:pages,method:'heuristic-color-coverage-v1'});
  }catch(e){ res.status(400).json({error:e.message||'No se pudo analizar el PDF.'}); }
}
