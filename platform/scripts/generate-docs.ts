import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/openapi';
import {
  OPENAPI_INTERNAL_SAFETY,
  OPENAPI_OPERATION_AUDIENCE,
  type OpenApiAudience,
} from '../src/openapi-audience';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsDirectory = resolve(scriptDirectory, '../../docs');
const publicSpecPath = resolve(docsDirectory, 'api-reference/openapi.json');
const internalPagePath = resolve(docsDirectory, 'internals/endpoints.mdx');
const checkOnly = process.argv.includes('--check');

type Operation = {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, unknown>>;
  tags?: string[];
  [key: string]: unknown;
};

type PathItem = Record<string, Operation | unknown>;
type Document = Omit<Record<string, unknown>, 'paths'> & { paths: Record<string, PathItem> };

type InventoryEntry = {
  audience: OpenApiAudience;
  method: string;
  operation: Operation;
  operationId: string;
  path: string;
};

const fullDocument = structuredClone(openApiDocument) as unknown as Document;
const inventory = collectOperations(fullDocument);
assertAudienceCoverage(inventory);
assertInternalSafetyCoverage(inventory);

const publicDocument = buildPublicDocument(fullDocument, inventory);
const publicJson = `${JSON.stringify(publicDocument, null, 2)}\n`;
const internalMdx = buildInternalPage(inventory);

await emit(publicSpecPath, publicJson);
await emit(internalPagePath, internalMdx);

function collectOperations(document: Document): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, candidate] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !candidate || typeof candidate !== 'object') continue;
      const operation = candidate as Operation;
      if (!operation.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId.`);
      const audience = OPENAPI_OPERATION_AUDIENCE[operation.operationId];
      if (!audience) throw new Error(`${operation.operationId} has no documentation audience.`);
      entries.push({ audience, method, operation, operationId: operation.operationId, path });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function assertAudienceCoverage(entries: InventoryEntry[]): void {
  const published = new Set(entries.map((entry) => entry.operationId));
  const classified = Object.keys(OPENAPI_OPERATION_AUDIENCE);
  const stale = classified.filter((operationId) => !published.has(operationId));
  if (stale.length) throw new Error(`Documentation audiences contain stale operation IDs: ${stale.join(', ')}`);
}

function assertInternalSafetyCoverage(entries: InventoryEntry[]): void {
  const internal = new Set(entries.filter((entry) => entry.audience !== 'consumer').map((entry) => entry.operationId));
  const documented = new Set(Object.keys(OPENAPI_INTERNAL_SAFETY));
  const missing = [...internal].filter((operationId) => !documented.has(operationId));
  const stale = [...documented].filter((operationId) => !internal.has(operationId));
  if (missing.length) throw new Error(`Internal operations have no safety note: ${missing.join(', ')}`);
  if (stale.length) throw new Error(`Internal safety notes contain stale operation IDs: ${stale.join(', ')}`);
}

function buildPublicDocument(document: Document, entries: InventoryEntry[]): Document {
  const consumerIds = new Set(entries.filter((entry) => entry.audience === 'consumer').map((entry) => entry.operationId));
  const paths: Record<string, PathItem> = {};
  const usedTags = new Set<string>();

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const nextPathItem: PathItem = {};
    for (const [key, candidate] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(key)) {
        nextPathItem[key] = candidate;
        continue;
      }
      const operation = candidate as Operation;
      if (!operation.operationId || !consumerIds.has(operation.operationId)) continue;
      const nextOperation = structuredClone(operation);
      nextOperation['x-video2ctx-audience'] = 'consumer';
      nextOperation.security = bearerFirst(nextOperation.security);
      nextOperation.tags?.forEach((tag) => usedTags.add(tag));
      nextPathItem[key] = nextOperation;
    }
    if (Object.keys(nextPathItem).some((key) => HTTP_METHODS.has(key))) paths[path] = nextPathItem;
  }

  const tags = Array.isArray(document.tags)
    ? document.tags.filter((tag) => typeof tag === 'object' && tag !== null && usedTags.has(String((tag as { name?: unknown }).name)))
    : document.tags;

  return {
    ...document,
    info: {
      ...(document.info as Record<string, unknown>),
      description: 'Consumer-facing contract for the hosted video2ctx API. First-party application and operator routes are documented separately at https://docs.video2ctx.dev/internals/overview.',
    },
    servers: [{ url: 'https://api.video2ctx.dev', description: 'Hosted video2ctx API' }],
    tags,
    paths,
  };
}

function bearerFirst(security: Operation['security']): Operation['security'] {
  if (!Array.isArray(security)) return security;
  return [...security].sort((left, right) => Number('bearerApiKey' in right) - Number('bearerApiKey' in left));
}

function buildInternalPage(entries: InventoryEntry[]): string {
  const internal = entries.filter((entry) => entry.audience !== 'consumer');
  const groups: Array<{ audience: Exclude<OpenApiAudience, 'consumer'>; title: string; description: string }> = [
    { audience: 'first-party', title: 'First-party application operations', description: 'Called by the video2ctx web application or an explicit signed-in account action.' },
    { audience: 'callback', title: 'Callbacks and signed links', description: 'Called by an external provider or through a signed link with protocol-specific state.' },
    { audience: 'operator', title: 'Operator operations', description: 'Reserved for authorized video2ctx platform administration.' },
  ];

  const sections = groups.map((group) => {
    const rows = internal.filter((entry) => entry.audience === group.audience).map((entry) =>
      `| \`${entry.method.toUpperCase()}\` | \`${escapeTable(entry.path)}\` | \`${entry.operationId}\` | ${escapeTable(entry.operation.summary ?? '—')} | ${securityLabel(entry.operation.security)} | ${escapeTable(OPENAPI_INTERNAL_SAFETY[entry.operationId])} |`
    );
    return `## ${group.title}\n\n${group.description}\n\n| Method | Path | Operation ID | Summary | Declared access | Safety notes |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}`;
  });

  return `---\ntitle: "Internal endpoint inventory"\ndescription: "Generated non-interactive inventory of first-party, callback, and operator operations."\n---\n\n<Warning>\n  These routes are documented for transparency and maintainers. They are intentionally excluded from the interactive API playground.\n</Warning>\n\nThis page is generated from \`platform/src/openapi.ts\` and the exhaustive audience map. Do not edit it by hand.\n\n${sections.join('\n\n')}\n`;
}

function securityLabel(security: Operation['security']): string {
  if (!security?.length) return 'Public or protocol-signed';
  const alternatives = security.flatMap((requirement) => Object.keys(requirement));
  return alternatives.length ? alternatives.map(code).join(' or ') : 'Public';
}

function code(value: string): string {
  return `\`${escapeTable(value)}\``;
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function emit(path: string, content: string): Promise<void> {
  if (checkOnly) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current !== content) throw new Error(`${path} is stale. Run npm run docs:generate.`);
    return;
  }
  await writeFile(path, content);
}
