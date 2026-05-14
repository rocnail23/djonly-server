import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Stripe from 'stripe';
import { envs } from 'src/config/envs';

interface CreateStripeCheckoutSessionInput {
  readonly userId: string;
  readonly priceId: string;
}

interface CreateBillingPortalSessionInput {
  readonly customerId: string;
  readonly returnUrl: string;
}

interface UpgradeStripeSubscriptionInput {
  readonly subscriptionId: string;
  readonly newPriceId: string;
}

export interface StripeCheckoutSessionResponse {
  readonly id: string;
  readonly url: string;
}

export interface StripePrice {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly interval: string | null;
  readonly intervalCount: number | null;
  readonly productName: string | null;
  readonly productDescription: string | null;
}

export interface StripeBillingPortalSessionResponse {
  readonly url: string;
}

export interface StripeInvoiceSummary {
  readonly id: string;
  readonly number: string | null;
  readonly status: string | null;
  readonly amountPaid: number;
  readonly amountDue: number;
  readonly currency: string;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly createdAt: Date;
}

export interface StripeSubscriptionUpgradeResponse {
  readonly subscriptionId: string;
  readonly invoiceId: string | null;
  readonly fromPriceId: string;
  readonly toPriceId: string;
  readonly hasPendingUpdate: boolean;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripeClient = envs.STRIPE_SECRET_KEY
    ? new Stripe(envs.STRIPE_SECRET_KEY)
    : null;

  private getStripeClient(): Stripe {
    if (!this.stripeClient) {
      throw new ServiceUnavailableException('Stripe no está configurado');
    }
    return this.stripeClient;
  }

  public async createCheckoutSession(
    input: CreateStripeCheckoutSessionInput,
  ): Promise<StripeCheckoutSessionResponse> {
    this.logger.log(
      `Creating Stripe checkout session user=${input.userId} price=${input.priceId}`,
    );
    const session = await this.createStripeSession(input);
    const id = session.id;
    const url = session.url;
    if (typeof id !== 'string' || typeof url !== 'string') {
      throw new InternalServerErrorException(
        'Stripe devolvió una sesión inválida',
      );
    }

    this.logger.log(
      `Stripe checkout session created id=${id} user=${input.userId}`,
    );
    return {
      id,
      url,
    };
  }

  public async cancelSubscriptionImmediately(
    subscriptionId: string,
  ): Promise<void> {
    try {
      this.logger.log(`Canceling Stripe subscription id=${subscriptionId}`);
      await this.getStripeClient().subscriptions.cancel(subscriptionId);
      this.logger.log(`Stripe subscription canceled id=${subscriptionId}`);
    } catch (error: unknown) {
      this.logger.error('Stripe subscription cancellation failed', error);
      throw new InternalServerErrorException(
        'No se pudo cancelar la suscripción en Stripe',
      );
    }
  }

  public async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<StripeBillingPortalSessionResponse> {
    try {
      this.logger.log(
        `Creating Stripe billing portal session customer=${input.customerId}`,
      );
      const session =
        await this.getStripeClient().billingPortal.sessions.create({
          customer: input.customerId,
          return_url: input.returnUrl,
        });
      if (!session.url) {
        throw new InternalServerErrorException(
          'Stripe devolvió una sesión de portal inválida',
        );
      }
      return {
        url: session.url,
      };
    } catch (error: unknown) {
      this.logger.error('Stripe billing portal creation failed', error);
      throw new InternalServerErrorException(
        'No se pudo crear la sesión de portal de Stripe',
      );
    }
  }

  public async listInvoicesByCustomer(
    customerId: string,
  ): Promise<readonly StripeInvoiceSummary[]> {
    try {
      this.logger.log(`Listing Stripe invoices customer=${customerId}`);
      const invoices = await this.getStripeClient().invoices.list({
        customer: customerId,
        limit: 50,
      });
      return invoices.data.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        amountPaid: (invoice.amount_paid ?? 0) / 100,
        amountDue: (invoice.amount_due ?? 0) / 100,
        currency: (invoice.currency ?? 'usd').toUpperCase(),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdfUrl: invoice.invoice_pdf ?? null,
        createdAt: new Date(invoice.created * 1000),
      }));
    } catch (error: unknown) {
      this.logger.error('Stripe invoice listing failed', error);
      throw new InternalServerErrorException(
        'No se pudieron obtener los invoices de Stripe',
      );
    }
  }

  public constructWebhookEvent(input: {
    readonly rawBody: Buffer;
    readonly signature: string;
  }): Stripe.Event {
    if (!envs.STRIPE_WEBHOOK_SECRET) {
      throw new ServiceUnavailableException(
        'Stripe webhook no está configurado',
      );
    }
    try {
      const event = this.getStripeClient().webhooks.constructEvent(
        input.rawBody,
        input.signature,
        envs.STRIPE_WEBHOOK_SECRET,
      );
      this.logger.log(`Stripe webhook signature validated type=${event.type}`);
      return event;
    } catch {
      this.logger.error('Stripe webhook signature validation failed');
      throw new BadRequestException('Firma de webhook Stripe inválida');
    }
  }

  public async listRecurringPrices(): Promise<readonly StripePrice[]> {
    try {
      this.logger.log('Listing Stripe recurring prices');
      const prices = await this.getStripeClient().prices.list({
        active: true,
        expand: ['data.product'],
        limit: 100,
        type: 'recurring',
      });
      const mappedPrices = prices.data
        .filter((price) => {
          if (!price.product || typeof price.product === 'string') return false;
          if ('deleted' in price.product && price.product.deleted) return false;
          return price.product.active === true;
        })
        .map((price) => {
          const unitAmount = price.unit_amount ? price.unit_amount / 100 : 0;
          const currency = price.currency ?? 'usd';
          const interval = price.recurring?.interval ?? null;
          const intervalCount = price.recurring?.interval_count
            ? price.recurring.interval_count
            : interval
              ? 1
              : null;
          const productName = this.resolveProductName(price.product);
          const productDescription = this.resolveProductDescription(
            price.product,
          );
          return {
            id: price.id,
            amount: unitAmount,
            currency,
            interval,
            intervalCount,
            productName,
            productDescription,
          };
        });
      this.logger.log(
        `Stripe recurring prices loaded count=${mappedPrices.length}`,
      );
      return mappedPrices;
    } catch (error: unknown) {
      this.logger.error('Stripe price listing failed', error);
      throw new InternalServerErrorException(
        'No se pudieron obtener los precios de Stripe',
      );
    }
  }

  public async retrieveSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription> {
    try {
      this.logger.log(`Retrieving Stripe subscription id=${subscriptionId}`);
      const subscription =
        await this.getStripeClient().subscriptions.retrieve(subscriptionId);
      this.logger.log(`Stripe subscription retrieved id=${subscriptionId}`);
      return subscription;
    } catch (error: unknown) {
      this.logger.error('Stripe subscription retrieval failed', error);
      throw new InternalServerErrorException(
        'No se pudo obtener la suscripción de Stripe',
      );
    }
  }

  public async upgradeSubscription(
    input: UpgradeStripeSubscriptionInput,
  ): Promise<StripeSubscriptionUpgradeResponse> {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    const currentItem = subscription.items.data[0];
    const currentItemId = currentItem?.id;
    const currentPriceId = currentItem?.price?.id;
    if (
      typeof currentItemId !== 'string' ||
      typeof currentPriceId !== 'string'
    ) {
      throw new BadRequestException(
        'La suscripción no tiene un item actual válido para actualizar',
      );
    }
    if (currentPriceId === input.newPriceId) {
      throw new BadRequestException('La suscripción ya usa ese precio');
    }
    const targetPrice = await this.retrieveRecurringPrice(input.newPriceId);
    this.assertCanUpgradePrice({
      currentPrice: currentItem.price,
      targetPrice,
    });
    try {
      const updatedSubscription =
        await this.getStripeClient().subscriptions.update(subscription.id, {
          payment_behavior: 'pending_if_incomplete',
          proration_behavior: 'always_invoice',
          items: [
            {
              id: currentItemId,
              price: input.newPriceId,
            },
          ],
        });
      return {
        subscriptionId: updatedSubscription.id,
        invoiceId: this.resolveLatestInvoiceId(
          updatedSubscription.latest_invoice,
        ),
        fromPriceId: currentPriceId,
        toPriceId: input.newPriceId,
        hasPendingUpdate: Boolean(updatedSubscription.pending_update),
      };
    } catch (error: unknown) {
      this.logger.error('Stripe subscription upgrade failed', error);
      throw new InternalServerErrorException(
        'No se pudo actualizar la suscripción en Stripe',
      );
    }
  }

  private async retrieveRecurringPrice(priceId: string): Promise<Stripe.Price> {
    try {
      const price = await this.getStripeClient().prices.retrieve(priceId);
      if (!price.recurring) {
        throw new BadRequestException('El nuevo precio no es recurrente');
      }
      return price;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Stripe price retrieval failed', error);
      throw new InternalServerErrorException(
        'No se pudo obtener el precio de Stripe',
      );
    }
  }

  private assertCanUpgradePrice(input: {
    readonly currentPrice: Stripe.Price;
    readonly targetPrice: Stripe.Price;
  }): void {
    const currentAmount = this.resolvePriceAmountInMinorUnits(
      input.currentPrice,
    );
    const targetAmount = this.resolvePriceAmountInMinorUnits(input.targetPrice);
    if (targetAmount < currentAmount) {
      throw new BadRequestException(
        'Para cambiar a un plan menor debes cancelar tu suscripción actual, esperar el vencimiento del período y luego adquirir el nuevo plan',
      );
    }
  }

  private resolvePriceAmountInMinorUnits(price: Stripe.Price): number {
    if (typeof price.unit_amount !== 'number') {
      throw new BadRequestException(
        'La suscripción tiene un precio inválido para actualizar',
      );
    }
    return price.unit_amount;
  }

  private async createStripeSession(
    input: CreateStripeCheckoutSessionInput,
  ): Promise<Stripe.Checkout.Session> {
    try {
      return await this.getStripeClient().checkout.sessions.create({
        mode: 'subscription',
        success_url: envs.STRIPE_SUCCESS_URL || 'http://localhost:3000',
        cancel_url: envs.STRIPE_CANCEL_URL || 'http://localhost:3000',
        client_reference_id: input.userId,
        line_items: [
          {
            price: input.priceId,
            quantity: 1,
          },
        ],
        metadata: {
          user_id: input.userId,
        },
        subscription_data: {
          metadata: {
            user_id: input.userId,
          },
        },
      });
    } catch (error: unknown) {
      this.logger.error('Stripe checkout session creation failed', error);
      throw new InternalServerErrorException(
        'No se pudo crear la sesión de checkout en Stripe',
      );
    }
  }

  private resolveProductName(
    product: string | Stripe.Product | Stripe.DeletedProduct | null | undefined,
  ): string | null {
    if (!product || typeof product === 'string') {
      return null;
    }
    if ('deleted' in product && product.deleted) {
      return null;
    }
    return product.name ?? null;
  }

  private resolveProductDescription(
    product: string | Stripe.Product | Stripe.DeletedProduct | null | undefined,
  ): string | null {
    if (!product || typeof product === 'string') {
      return null;
    }
    if ('deleted' in product && product.deleted) {
      return null;
    }
    return product.description ?? null;
  }

  private resolveLatestInvoiceId(
    latestInvoice: string | Stripe.Invoice | null,
  ): string | null {
    if (typeof latestInvoice === 'string') {
      return latestInvoice;
    }
    if (!latestInvoice || typeof latestInvoice.id !== 'string') {
      return null;
    }
    return latestInvoice.id;
  }
}
