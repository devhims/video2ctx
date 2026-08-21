import { describe, expect, test } from 'vitest';
import { openApiDocument } from '../src/openapi';
import { OPENAPI_INTERNAL_SAFETY, OPENAPI_OPERATION_AUDIENCE } from '../src/openapi-audience';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

describe('documentation audience', () => {
  test('classifies every OpenAPI operation exactly once', () => {
    const operationIds = Object.values(openApiDocument.paths).flatMap((pathItem) =>
      Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([, operation]) => (operation as { operationId?: string }).operationId),
    );

    expect(operationIds.every(Boolean)).toBe(true);
    expect(new Set(operationIds)).toEqual(new Set(Object.keys(OPENAPI_OPERATION_AUDIENCE)));
  });

  test('keeps callbacks, administration, and account deletion out of the consumer playground', () => {
    expect(OPENAPI_OPERATION_AUDIENCE.getBilling).toBe('first-party');
    expect(OPENAPI_OPERATION_AUDIENCE.completeYouTubeOAuth).toBe('callback');
    expect(OPENAPI_OPERATION_AUDIENCE.listAdminJobs).toBe('operator');
    expect(OPENAPI_OPERATION_AUDIENCE.deleteAccount).toBe('first-party');
  });

  test('documents a safety note for every non-consumer operation', () => {
    const internalOperationIds = Object.entries(OPENAPI_OPERATION_AUDIENCE)
      .filter(([, audience]) => audience !== 'consumer')
      .map(([operationId]) => operationId);

    expect(new Set(Object.keys(OPENAPI_INTERNAL_SAFETY))).toEqual(new Set(internalOperationIds));
    expect(Object.values(OPENAPI_INTERNAL_SAFETY).every((note) => note.length > 20)).toBe(true);
  });
});
