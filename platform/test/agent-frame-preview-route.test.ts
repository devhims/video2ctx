vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));
const auth = vi.hoisted(() => ({ getSession: vi.fn().mockResolvedValue(null), verifyApiKey: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ createAuth: () => ({ api: auth }) }));

import { app } from '../src/app';
import { framePreviewKey } from '../src/agents/runtime/frame-previews';

const collectionId = 'a'.repeat(64), assetId = 'b'.repeat(64);
const path = `/v1/agent/frames/${collectionId}/${assetId}`;
const executionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const get = vi.fn();
const env = { RESEARCH: { get } } as unknown as Env;
beforeEach(() => { vi.clearAllMocks(); });

test('serves the original bytes without cookies, a key, auth lookup, or a runtime call', async () => {
  const bytes = new Uint8Array([255, 216, 255, 217]);
  get.mockResolvedValue({ body: new Response(bytes).body });
  const response = await app.request(path, {}, env, executionContext);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(get).toHaveBeenCalledWith(framePreviewKey(collectionId, assetId));
  expect(auth.getSession).not.toHaveBeenCalled();
  expect(auth.verifyApiKey).not.toHaveBeenCalled();
  expect(response.headers.get('Content-Type')).toBe('image/jpeg');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
});

test('returns 404 for a missing or deleted image', async () => {
  get.mockResolvedValue(null);
  expect((await app.request(path, {}, env, executionContext)).status).toBe(404);
});

test.each(['not-a-collection', 'private', 'a'.repeat(65)])('rejects invalid collections before reading storage: %s', async id => {
  expect((await app.request(`/v1/agent/frames/${id}/${assetId}`, {}, env, executionContext)).status).toBe(422);
  expect(get).not.toHaveBeenCalled();
});

test('does not make session reads or frame extraction public', async () => {
  const session = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  expect((await app.request(`/v1/agent/sessions/${session}`, {}, env, executionContext)).status).toBe(401);
  expect((await app.request('/v1/agent', { method: 'POST' }, env, executionContext)).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
});

test('serves a shared image only through its live private preview reference', async () => {
  const bytes=new Uint8Array([255,216,255,217]);
  const sharedImageKey=`youtube/videos/abcdefghijk/images/${'c'.repeat(64)}.jpg`;
  const sharedGet=vi.fn().mockImplementation(async()=>({body:new Response(bytes).body}));
  const sharedEnv={...env,VIDEO_ASSETS:{get:sharedGet}} as unknown as Env;
  get.mockResolvedValue({httpMetadata:{contentType:'application/json'},json:async()=>({sharedImageKey})});
  const response=await app.request(path,{},sharedEnv,executionContext);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(sharedGet).toHaveBeenCalledWith(sharedImageKey);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  get.mockResolvedValue(null);
  sharedGet.mockClear();
  expect((await app.request(path,{},sharedEnv,executionContext)).status).toBe(404);
  expect(sharedGet).not.toHaveBeenCalled();
});

test('rejects malformed shared preview references without reading arbitrary R2 keys',async()=>{
  const sharedGet=vi.fn();
  get.mockResolvedValue({httpMetadata:{contentType:'application/json'},json:async()=>({sharedImageKey:'private/analysis.json'})});
  expect((await app.request(path,{}, {...env,VIDEO_ASSETS:{get:sharedGet}} as unknown as Env,executionContext)).status).toBe(404);
  expect(sharedGet).not.toHaveBeenCalled();
});

test('serves an inline frame through a revocable private capability', async () => {
  const sharedFrameKey=`youtube/videos/abcdefghijk/frame/${'c'.repeat(64)}/${'d'.repeat(64)}.json`;
  const value={videoId:'abcdefghijk',frames:[{timestampMs:1000,width:640,height:360,mimeType:'image/jpeg',imageBase64:'/9j/AA=='}],
    failures:[],meta:{partial:false,warnings:[]}};
  const sharedGet=vi.fn(async()=>({json:async()=>value}));
  const sharedEnv={...env,VIDEO_ASSETS:{get:sharedGet}} as unknown as Env;
  get.mockResolvedValue({httpMetadata:{contentType:'application/json'},json:async()=>({sharedFrameKey})});
  const response=await app.request(path,{},sharedEnv,executionContext);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255,216,255,0]));
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Content-Type')).toBe('image/jpeg');
  get.mockResolvedValue(null); sharedGet.mockClear();
  expect((await app.request(path,{},sharedEnv,executionContext)).status).toBe(404);
  expect(sharedGet).not.toHaveBeenCalled();
});

test.each(['private/analysis.json',`youtube/videos/abcdefghijk/transcript/${'c'.repeat(64)}/${'d'.repeat(64)}.json`])('rejects inline references outside frame storage: %s',async sharedFrameKey=>{
  const sharedGet=vi.fn();
  get.mockResolvedValue({httpMetadata:{contentType:'application/json'},json:async()=>({sharedFrameKey})});
  expect((await app.request(path,{}, {...env,VIDEO_ASSETS:{get:sharedGet}} as unknown as Env,executionContext)).status).toBe(404);
  expect(sharedGet).not.toHaveBeenCalled();
});

test.each([null,{}, {videoId:'abcdefghijk',frames:[{timestampMs:1000,width:640,height:360,mimeType:'image/jpeg',imageBase64:'/9j/A'}],failures:[],meta:{partial:false,warnings:[]}}])('rejects a missing or corrupt inline frame',async value=>{
  const sharedFrameKey=`youtube/videos/abcdefghijk/frame/${'c'.repeat(64)}/${'d'.repeat(64)}.json`;
  const sharedGet=vi.fn(async()=>value===null?null:{json:async()=>value});
  get.mockResolvedValue({httpMetadata:{contentType:'application/json'},json:async()=>({sharedFrameKey})});
  expect((await app.request(path,{}, {...env,VIDEO_ASSETS:{get:sharedGet}} as unknown as Env,executionContext)).status).toBe(404);
});
