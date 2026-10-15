import type { CheckoutOptions } from '@polar-sh/better-auth';
import type { Polar } from '@polar-sh/sdk';
import type { Customer } from '@polar-sh/sdk/models/components/customer';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod/v4';
import { billingAccount } from './billing-coordination';
import { safeErrorLog } from './http';

/** Billing identity and redirects come from the server, never from checkout form input. */
export function checkout(env: Env, options: Pick<CheckoutOptions, 'products' | 'successUrl' | 'returnUrl' | 'theme'>) {
  return (client: Polar) => ({
    checkout: createAuthEndpoint('/checkout', {
      method: 'POST',
      body: z.object({ slug: z.string(), redirect: z.boolean().optional() }),
      use: [sessionMiddleware],
    }, async (ctx) => {
      const user = ctx.context.session.user;
      if ('isAnonymous' in user && user.isAnonymous) throw new APIError('UNAUTHORIZED');
      const products = typeof options.products === 'function' ? await options.products() : options.products;
      const product = products?.find((candidate) => candidate.slug === ctx.body.slug);
      if (!product?.productId) throw new APIError('BAD_REQUEST', { message: 'Product not found.' });
      const account = await billingAccount(env, user.id);
      const claim = crypto.randomUUID();
      if (!await account.beginBillingCheckout(claim)) {
        throw new APIError('CONFLICT', { message: 'Account deletion is in progress. Checkout is unavailable.' });
      }
      try {
        if (!await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(user.id).first()) throw new APIError('UNAUTHORIZED');
        const customer = await checkoutCustomer(client, user);
        const result = await client.checkouts.create({
          products: [product.productId],
          customerId: customer.id,
          metadata: { app_user_id: user.id },
          successUrl: options.successUrl,
          returnUrl: options.returnUrl,
        });
        // With customer_id, Polar may omit the checkout's external ID echo.
        if (result.customerId !== customer.id
          || (result.externalCustomerId !== null && result.externalCustomerId !== user.id)) {
          throw new CheckoutIdentityError('POLAR_CHECKOUT_IDENTITY_MISMATCH');
        }
        const url = new URL(result.url);
        if (options.theme) url.searchParams.set('theme', options.theme);
        return ctx.json({ url: url.toString(), redirect: ctx.body.redirect ?? true });
      } catch (error) {
        console.error({ event: 'polar_checkout_failed', userId: user.id, productId: product.productId,
          ...safeErrorLog(error),
          statusCode: statusCode(error) });
        if (error instanceof CheckoutIdentityError) {
          throw new APIError('CONFLICT', { message: 'Your billing customer needs reconciliation before checkout. Please contact support.' });
        }
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create checkout for your account.' });
      } finally {
        await account.endBillingCheckout(claim);
      }
    }),
  });
}

class CheckoutIdentityError extends Error {
  constructor(readonly code: string) {
    super('Billing customer identity mismatch');
    this.name = 'CheckoutIdentityError';
  }
}

/** Never recover an email collision by adopting or relinking another external ID. */
async function checkoutCustomer(client: Polar, user: { id: string; email: string; name: string }): Promise<Customer> {
  let customer: Customer;
  try {
    customer = await client.customers.getExternal({ externalId: user.id });
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
    try {
      customer = await client.customers.create({ externalId: user.id, email: user.email, name: user.name });
    } catch (createError) {
      // Concurrent checkouts can race to create the same external ID. Only that ID
      // may resolve the race. An old account with the same email must not be reused.
      if (statusCode(createError) !== 409 && statusCode(createError) !== 422) throw createError;
      try {
        customer = await client.customers.getExternal({ externalId: user.id });
      } catch (lookupError) {
        if (statusCode(lookupError) !== 404) throw lookupError;
        throw new CheckoutIdentityError('POLAR_CUSTOMER_IDENTITY_CONFLICT');
      }
    }
  }
  if (customer.deletedAt || customer.externalId !== user.id || typeof customer.email !== 'string'
    || customer.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    throw new CheckoutIdentityError('POLAR_CUSTOMER_IDENTITY_MISMATCH');
  }
  return customer;
}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    && typeof error.statusCode === 'number' ? error.statusCode : undefined;
}
