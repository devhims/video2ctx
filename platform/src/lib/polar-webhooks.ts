import type { WebhooksOptions } from '@polar-sh/better-auth';
import { WebhookCustomerStateChangedPayload$inboundSchema } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import { WebhookOrderPaidPayload$inboundSchema } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import { WebhookOrderRefundedPayload$inboundSchema } from '@polar-sh/sdk/models/components/webhookorderrefundedpayload';
import { WebhookSubscriptionRevokedPayload$inboundSchema } from '@polar-sh/sdk/models/components/webhooksubscriptionrevokedpayload';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { Webhook } from 'standardwebhooks';

type PaymentWebhookOptions = Pick<WebhooksOptions,
  'secret' | 'onOrderPaid' | 'onOrderRefunded' | 'onCustomerStateChanged' | 'onSubscriptionRevoked'>;

/** Keep the pinned SDK's typed payloads while accepting both Polar signing schemes. */
export function webhooks(options: PaymentWebhookOptions) {
  return () => ({
    polarWebhooks: createAuthEndpoint('/polar/webhooks', {
      method: 'POST', metadata: { isAction: false }, cloneRequest: true,
    }, async (ctx) => {
      const request = ctx.request;
      if (!request || !options.secret) throw new APIError('INTERNAL_SERVER_ERROR');
      const body = await readBody(request);
      const headers = Object.fromEntries(['webhook-id', 'webhook-timestamp', 'webhook-signature']
        .map((name) => [name, request.headers.get(name) ?? '']));
      let payload: unknown;
      try {
        payload = new Webhook(options.secret).verify(body, headers);
      } catch {
        try {
          // Older Polar endpoints sign with the UTF-8 bytes of the entire secret.
          payload = new Webhook(Buffer.from(options.secret, 'utf8').toString('base64')).verify(body, headers);
        } catch {
          throw new APIError('BAD_REQUEST', { message: 'Invalid webhook signature.' });
        }
      }
      const type = (payload as { type?: unknown } | null)?.type;
      // Parse before calling a handler so invalid payloads cannot alter billing.
      const parsed = parsePaymentEvent(type, payload);
      try {
        switch (parsed.type) {
          case 'order.paid': await options.onOrderPaid?.(parsed); break;
          case 'order.refunded': await options.onOrderRefunded?.(parsed); break;
          case 'customer.state_changed': await options.onCustomerStateChanged?.(parsed); break;
          case 'subscription.revoked': await options.onSubscriptionRevoked?.(parsed); break;
        }
      } catch {
        ctx.context.logger.error('Polar payment webhook processing failed.');
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Webhook processing failed.' });
      }
      return ctx.json({ received: true });
    }),
  });
}

function parsePaymentEvent(type: unknown, payload: unknown) {
  try {
    switch (type) {
      case 'order.paid': return WebhookOrderPaidPayload$inboundSchema.parse(payload);
      case 'order.refunded': return WebhookOrderRefundedPayload$inboundSchema.parse(payload);
      case 'customer.state_changed': return WebhookCustomerStateChangedPayload$inboundSchema.parse(payload);
      case 'subscription.revoked': return WebhookSubscriptionRevokedPayload$inboundSchema.parse(payload);
      default: throw new Error('Unsupported event');
    }
  } catch {
    throw new APIError('BAD_REQUEST', { message: 'Invalid or unsupported payment webhook payload.' });
  }
}

async function readBody(request: Request): Promise<string> {
  if (!request.body) throw new APIError('BAD_REQUEST');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1_048_576) {
      await reader.cancel();
      throw new APIError('PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
