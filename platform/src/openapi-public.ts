import { OPENAPI_OPERATION_AUDIENCE } from './openapi-audience';

export const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export type Operation = {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, unknown>>;
  tags?: string[];
  [key: string]: unknown;
};

export type PathItem = Record<string, Operation | unknown>;
export type Document = Omit<Record<string, unknown>, 'paths'> & { paths: Record<string, PathItem> };

export function buildPublicDocument(document: Document): Document {
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
      if (!operation.operationId || OPENAPI_OPERATION_AUDIENCE[operation.operationId] !== 'consumer') continue;
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
