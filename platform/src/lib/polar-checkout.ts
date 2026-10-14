import type { CheckoutOptions } from '@polar-sh/better-auth';
import type { Polar } from '@polar-sh/sdk';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod/v4';
import { safeErrorLog } from './http';

/** Billing identity and redirects come from the server, never from checkout form input. */
export function checkout(options: Pick<CheckoutOptions, 'products' | 'successUrl' | 'returnUrl' | 'theme'>) {
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
      try {
        const result = await client.checkouts.create({
          products: [product.productId],
          externalCustomerId: user.id,
          customerEmail: user.email,
          customerName: user.name,
          metadata: { app_user_id: user.id },
          successUrl: options.successUrl,
          returnUrl: options.returnUrl,
        });
        if (result.externalCustomerId !== user.id) throw Object.assign(new Error('Checkout identity mismatch'), { code: 'POLAR_CHECKOUT_IDENTITY_MISMATCH' });
        const url = new URL(result.url);
        if (options.theme) url.searchParams.set('theme', options.theme);
        return ctx.json({ url: url.toString(), redirect: ctx.body.redirect ?? true });
      } catch (error) {
        console.error({ event: 'polar_checkout_failed', userId: user.id, productId: product.productId,
          ...safeErrorLog(error),
          statusCode: typeof error === 'object' && error !== null && 'statusCode' in error
            && typeof error.statusCode === 'number' ? error.statusCode : undefined });
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create checkout for your account.' });
      }
    }),
  });
}
