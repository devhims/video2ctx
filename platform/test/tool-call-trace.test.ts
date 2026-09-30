import { generateText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { traceToolSet, type TraceToolCall } from '../src/agents/runtime/tool-call-trace';

test('the actual SDK tool boundary captures full nested inputs and model-facing outputs', async () => {
  const input={text:'a'.repeat(1800),options:{ids:Array.from({length:40},(_,i)=>i)}};
  const output={findings:Array.from({length:30},(_,i)=>({index:i,text:'full returned text '.repeat(100)}))};
  const captured:Array<{toolCallId:string;name:string;input:unknown;output:unknown}>=[];
  const trace:TraceToolCall=async call=>{
    const result=await call.execute();
    captured.push({toolCallId:call.toolCallId,name:call.name,input:structuredClone(call.input),output:structuredClone(result)});
    return result;
  };
  const model=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'tool-call',toolCallId:'sdk-call',toolName:'inspect',input:JSON.stringify(input)}],
    finishReason:{unified:'tool-calls',raw:'tool_calls'},
    usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[],
  })});
  const tools={inspect:tool({description:'Inspect saved evidence.',inputSchema:z.object({text:z.string(),options:z.object({ids:z.array(z.number())})}),execute:async()=>output})};
  const result=await generateText({model,prompt:'Inspect this evidence.',tools:traceToolSet(tools,trace)});
  expect(captured).toEqual([{toolCallId:'sdk-call',name:'inspect',input,output}]);
  expect(result.toolResults[0]?.output).toEqual(output);
  expect(traceToolSet(tools)).toBe(tools);
});
