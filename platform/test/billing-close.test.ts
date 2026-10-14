const deleteExternal = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/polar-client', () => ({ polarClient: () => ({ customers: { deleteExternal } }) }));

import { closeBillingAccount } from '../src/lib/billing';

const polarError = (statusCode: number) => Object.assign(new Error(`Status ${statusCode}`), { statusCode });

describe('closing the billing account on account deletion', () => {
  beforeEach(() => { deleteExternal.mockReset(); });

  test('skips Polar when billing is not configured', async () => {
    await expect(closeBillingAccount({ POLAR_ACCESS_TOKEN: '' } as unknown as Env, 'user-1')).resolves.toBeUndefined();
    await expect(closeBillingAccount({} as unknown as Env, 'user-1')).resolves.toBeUndefined();
    expect(deleteExternal).not.toHaveBeenCalled();
  });

  test('anonymizes the Polar customer by external ID', async () => {
    deleteExternal.mockResolvedValue(undefined);
    await closeBillingAccount({ POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env, 'user-1');
    expect(deleteExternal).toHaveBeenCalledWith({ externalId: 'user-1', anonymize: true });
  });

  test('treats a missing Polar customer as already closed', async () => {
    deleteExternal.mockRejectedValue(polarError(404));
    await expect(closeBillingAccount({ POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env, 'user-1')).resolves.toBeUndefined();
  });

  test('stops deletion when Polar rejects the request', async () => {
    deleteExternal.mockRejectedValue(polarError(401));
    await expect(closeBillingAccount({ POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env, 'user-1')).rejects.toThrow('Status 401');
  });
});
