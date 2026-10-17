// Trends stays implemented but unpublished until it is rolled out again. While this is false the
// /v1/trends routes are not registered, the OpenAPI document omits them, and providers do not
// advertise the capability. web/lib/features.ts holds the matching dashboard switch.
export const TRENDS_ENABLED: boolean = false;
