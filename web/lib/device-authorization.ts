export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied';

export type DeviceAuthorization = {
  userCode: string;
  status: DeviceAuthorizationStatus;
};

export async function verifyDeviceAuthorization(
  userCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchImpl(
    `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } },
  );
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(errorDescription(payload, 'Could not verify this device code.'));
  if (!isRecord(payload)
    || typeof payload.user_code !== 'string'
    || !isStatus(payload.status)) {
    throw new Error('The device authorization response was invalid.');
  }
  return { userCode: payload.user_code, status: payload.status };
}

export async function decideDeviceAuthorization(
  decision: 'approve' | 'deny',
  userCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`/api/auth/device/${decision}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ userCode }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(errorDescription(payload, `Could not ${decision} this device.`));
}

function errorDescription(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.error_description === 'string'
    ? payload.error_description.slice(0, 300)
    : fallback;
}

function isStatus(value: unknown): value is DeviceAuthorizationStatus {
  return value === 'pending' || value === 'approved' || value === 'denied';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
