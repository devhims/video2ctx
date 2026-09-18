/** Paid opt-in, synthetic data only. Run with node --env-file=.dev.vars --import tsx scripts/benchmark-fireworks-tiers.ts OUTPUT.json */
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createAgentModel } from '../src/agents/model';
const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
if (!apiKey) throw new Error('FIREWORKS_API_KEY is required.');
const destination = process.argv[2];
if (!destination) throw new Error('Provide a JSON output path.');
const startedAt = new Date().toISOString();
const env = { FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '',
  AGENT_GLM_PROVIDER: 'fireworks', AGENT_FINALIZER_PROVIDER: 'fireworks',
  AGENT_FINALIZER_MODEL: 'deepseek-v4-flash-0731' } as unknown as Env;
// Deterministic 512px contact sheet, four solid-color tiles. No user images.
function chunk(type: string, data: Buffer) {
  const content = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const b of content) { crc ^= b; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const size=Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum=Buffer.alloc(4); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([size,content,checksum]);
}
const pixels=Buffer.alloc(512*1537), colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
for(let y=0;y<512;y++) for(let x=0;x<512;x++) for(let k=0;k<3;k++) pixels[y*1537+1+x*3+k]=colors[(y>=256?2:0)+(x>=256?1:0)]![k]!;
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(512,0); ihdr.writeUInt32BE(512,4); ihdr[8]=8; ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const schema=z.object({answer:z.string(),items:z.array(z.string()).length(4)});
const tasks=[
 {name:'glm_text',role:'agent_core',images:0,prompt:'Synthetic test. Summarize these observations in one sentence and list the four colors: red, green, blue, yellow.'},
 {name:'glm_vision_4_sheets',role:'visual_analyst',images:4,prompt:'Synthetic visual test. Inspect all four identical contact sheets. Give one short sentence describing the layout, and list the four tile colors in row-major order.'},
 {name:'deepseek_finalizer',role:'finalizer',images:0,prompt:'Synthetic evidence: the four tiles are red, green, blue, yellow in row-major order. Produce a concise one-sentence conclusion and list the four colors. Do not add unsupported claims.'},
];
const nativeFetch=globalThis.fetch;
type Tier = 'standard' | 'priority';
let tier:Tier='priority', transport:Record<string,unknown>={};
// Use production SDK settings; remove Priority only for this benchmark's Standard control.
globalThis.fetch=async(input,init)=>{
 const body=JSON.parse(String(init?.body));
 if(body.service_tier!=='priority') throw new Error('Production model omitted Priority.');
 if(tier==='standard') delete body.service_tier;
 transport.sentTier=body.service_tier??'standard';
 const started=performance.now();
 const response=await nativeFetch(input,{...init,body:JSON.stringify(body)});
 transport.status=response.status; transport.headersMs=Math.round(performance.now()-started);
 // Capture only tier acknowledgment, never raw response bodies.
 if (response.ok) {
  const payload = await response.clone().json() as { service_tier?: string };
  if (payload.service_tier) transport.returnedTier = payload.service_tier;
 }
 transport.metrics=Object.fromEntries([...response.headers].filter(([key])=>key.startsWith('fireworks-')||key==='x-request-id'));
 return response;
};
const results:Record<string,unknown>[]=[];
try {
 for(const task of tasks) for(let pair=0;pair<5;pair++) {
  for(const selected of (pair%2?['priority','standard']:['standard','priority']) as Tier[]) {
   tier=selected; transport={};
   // Separate affinity per tier; alternate order to reduce warm-up/order bias.
   const model=createAgentModel(env,`tier-benchmark:${task.name}:${tier}`,'low',{model_role:task.role});
   const started=performance.now(); let details:Record<string,unknown>;
   try {
    const result=await generateText({model,messages:[{role:'user',content:[{type:'text',text:task.prompt},
     ...Array.from({length:task.images},()=>({type:'file' as const,data:png,mediaType:'image/png'}))]}],
     output:Output.object({schema}),maxOutputTokens:1600,maxRetries:0,temperature:0,abortSignal:AbortSignal.timeout(40_000)});
    details={completed:true,items:result.output.items,ok:result.output.items.map(x=>x.toLowerCase()).join(',')==='red,green,blue,yellow',finishReason:result.finishReason,usage:result.usage};
   } catch(error) { details={completed:false,ok:false,errorType:error instanceof Error?error.name:'unknown'}; }
   const row={task:task.name,pair,tier,model:model.modelId,elapsedMs:Math.round(performance.now()-started),...transport,...details};
   results.push(row); writeFileSync(destination,JSON.stringify({startedAt,samples:results},null,2)); console.log(JSON.stringify(row));
  }
 }
} finally {globalThis.fetch=nativeFetch;}
