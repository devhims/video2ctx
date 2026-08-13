import { ArrowRight, Check } from '@phosphor-icons/react/ssr';
import { CraftScaleInquiry } from './craft-scale-inquiry';

interface PricingPlan {
  name: string;
  price: string;
  cadence: string;
  credits: string;
  description: string;
  features: string[];
  cta: string;
  href?: string;
  inquiry?: boolean;
  recommended?: boolean;
}

const PLANS: PricingPlan[] = [
  {
    name: 'Starter',
    price: 'Free',
    cadence: 'No card required',
    credits: '1,000 credits once',
    description: 'Explore complete video data in the dashboard and API before committing.',
    features: [
      'Dashboard and API access',
      'Transcripts, comments, channels, and playlists',
      'Projects and monitoring',
      'One credit grant per account',
    ],
    cta: 'Start free',
    href: '/dashboard',
  },
  {
    name: 'Builder',
    price: '$20',
    cadence: 'per month',
    credits: '20,000 credits monthly',
    description: 'Build production applications, agents, and internal tools with recurring usage.',
    features: [
      'Everything in Starter',
      'Monthly credit renewal',
      'Higher project, monitor, and import limits',
      'Standard support',
    ],
    cta: 'Start building',
    href: '/dashboard',
    recommended: true,
  },
  {
    name: 'Scale',
    price: 'Custom',
    cadence: 'Built around your workload',
    credits: 'Custom credit allocation',
    description: 'Run video2ctx inside a product or data pipeline with company-level requirements.',
    features: [
      'Volume pricing and custom limits',
      'Invoice billing options',
      'Priority onboarding and support',
      'Security and SLA options',
    ],
    cta: 'Discuss Scale',
    inquiry: true,
  },
];

function PricingPlanCard({ plan }: { plan: PricingPlan }) {
  return (
    <article className='craft-pricing-plan' data-recommended={plan.recommended ? 'true' : undefined}>
      <div className='craft-pricing-plan-head'>
        <h3>{plan.name}</h3>
        {plan.recommended && <span>Recommended</span>}
      </div>

      <div className='craft-pricing-price'>
        <strong>{plan.price}</strong>
        <span>{plan.cadence}</span>
      </div>

      <p className='craft-pricing-credits'>{plan.credits}</p>
      <p className='craft-pricing-description'>{plan.description}</p>

      <ul aria-label={`${plan.name} plan features`}>
        {plan.features.map((feature) => (
          <li key={feature}>
            <Check size={14} weight='bold' aria-hidden='true' />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {plan.inquiry ? (
        <CraftScaleInquiry />
      ) : (
        <a className='craft-pricing-cta' href={plan.href}>
          {plan.cta}
          <ArrowRight size={13} weight='bold' aria-hidden='true' />
        </a>
      )}
    </article>
  );
}

export function CraftPricing() {
  return (
    <section className='craft-band craft-pricing' id='pricing' aria-labelledby='craft-pricing-title'>
      <div className='craft-band-head'>
        <h2 id='craft-pricing-title'>Start small. Pay when you build.</h2>
        <p>
          Every plan includes the dashboard and API. Credits are charged according to the data you request.
        </p>
      </div>

      <div className='craft-pricing-grid'>
        {PLANS.map((plan) => (
          <PricingPlanCard key={plan.name} plan={plan} />
        ))}
      </div>
    </section>
  );
}
