import { generateText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { traceToolCallRepair, traceToolSet, type TraceToolCall } from '../src/agents/runtime/tool-call-trace';

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

function rejectedCallModel(toolName: string, input: string) {
  return new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'tool-call',toolCallId:'rejected-call',toolName,input}],
    finishReason:{unified:'tool-calls',raw:'tool_calls'},
    usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[],
  })});
}
function captureAttempts() {
  const attempts: Array<{id:string;input:unknown;output?:unknown;error?:unknown}>=[];
  const trace:TraceToolCall=async call=>{
    const attempt:typeof attempts[number]={id:call.toolCallId,input:call.input};
    attempts.push(attempt);
    try {const result=await call.execute();attempt.output=result;return result;}
    catch(error) {attempt.error=error;throw error;}
  };
  return {attempts,trace};
}
const inspectionTools={inspect:tool({inputSchema:z.object({count:z.number()}),execute:async input=>input})};

test.each([
  ['inspect','{"count":"invalid"}',{count:'invalid'},'AI_InvalidToolInputError'],
  ['missing_tool','{"count":1}',{count:1},'AI_NoSuchToolError'],
  ['inspect','{"count":','{"count":','AI_InvalidToolInputError'],
])('captures rejected %s arguments %s without executing the tool',async(toolName,input,expected,errorName)=>{
  const {attempts,trace}=captureAttempts();
  const result=await generateText({model:rejectedCallModel(toolName,input),prompt:'Inspect.',
    tools:traceToolSet(inspectionTools,trace),repairToolCall:traceToolCallRepair(trace)});
  expect(result.content.some(item=>item.type==='tool-error')).toBe(true);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({id:'rejected-call',input:expected,error:{name:errorName}});
  expect(attempts[0]).not.toHaveProperty('output');
});

test('preserves a rejected attempt before a successful argument repair executes',async()=>{
  const {attempts,trace}=captureAttempts();
  const result=await generateText({model:rejectedCallModel('inspect','{"count":"invalid"}'),prompt:'Inspect.',
    tools:traceToolSet(inspectionTools,trace),repairToolCall:traceToolCallRepair(trace,async ({toolCall})=>{
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toBeDefined();
      return {...toolCall,input:'{"count":2}'};
    })});
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({id:'rejected-call',input:{count:'invalid'}});
  expect(attempts[1]).toEqual({id:'rejected-call',input:{count:2},output:{count:2}});
  expect(result.toolResults[0]?.output).toEqual({count:2});
});

test('retains the validation failure even when argument repair throws',async()=>{
  const {attempts,trace}=captureAttempts();
  const result=await generateText({model:rejectedCallModel('inspect','{"count":"invalid"}'),prompt:'Inspect.',
    tools:traceToolSet(inspectionTools,trace),repairToolCall:traceToolCallRepair(trace,async()=>{throw new Error('Repair timed out');})});
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.error).toMatchObject({name:'AI_InvalidToolInputError'});
  expect(result.content.some(item=>item.type==='tool-error')).toBe(true);
});
