import { CheckoutParams, type CheckoutOptions } from '@polar-sh/better-auth';
import type { Polar } from '@polar-sh/sdk';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';

/** Billing identity and redirects come from the server, never from checkout form input. */
export function checkout(options: CheckoutOptions) {
  return (client: Polar) => ({
    checkout: createAuthEndpoint('/checkout', {
      method: 'POST',
      body: CheckoutParams,
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
        if (result.externalCustomerId !== user.id) throw new Error('Checkout identity mismatch');
        const url = new URL(result.url);
        if (options.theme) url.searchParams.set('theme', options.theme);
        return ctx.json({ url: url.toString(), redirect: ctx.body.redirect ?? true });
      } catch {
        ctx.context.logger.error('Polar authenticated checkout creation failed.');
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create checkout for your account.' });
      }
    }),
  });
}
