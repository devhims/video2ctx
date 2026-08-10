import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';

export const metadata: Metadata = {
  title: 'Terms of Service · video2ctx',
  description: 'The terms governing access to and use of video2ctx.',
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow='Using the service'
      title='Terms of service'
      effectiveDate='August 10, 2026'
      summary='These terms set the ground rules for using video2ctx, including accounts, research data, credits, APIs, and AI-assisted output.'
    >
      <section>
        <h2>1. Agreement</h2>
        <p>
          These Terms of Service govern your access to video2ctx. By accessing or using the service, you agree to these terms and
          the Privacy Policy. If you do not agree, do not use the service.
        </p>
      </section>

      <section>
        <h2>2. Eligibility</h2>
        <p>
          You must be at least 18 years old and legally able to enter into this agreement. If you use video2ctx for an
          organization, you represent that you have authority to bind that organization, and “you” includes the organization.
        </p>
      </section>

      <section>
        <h2>3. Accounts and credentials</h2>
        <p>
          You are responsible for providing accurate account information, safeguarding your session and API keys, and all
          activity performed with your credentials. Notify us promptly if you suspect unauthorized access. Do not sell, share, or
          expose API keys. video2ctx may disable credentials that appear compromised or abusive.
        </p>
      </section>

      <section>
        <h2>4. The service</h2>
        <p>
          video2ctx helps users discover, inspect, organize, monitor, and analyse information from supported video platforms. The
          service may provide public-data lookup, transcripts, comments, projects, imports, exports, trend analysis, connected
          accounts, API access, and AI-assisted research features. Features may change as the service develops.
        </p>
      </section>

      <section>
        <h2>5. Complimentary credits and limits</h2>
        <p>
          video2ctx may provide complimentary credits or other usage allowances. Credits are a service-usage measurement, are not
          money or property, cannot be transferred or redeemed for cash, and may be subject to expiration, renewal, rate limits,
          and feature-specific costs. We may change allowances or limits prospectively, with reasonable notice when a change
          materially affects active users.
        </p>
      </section>

      <section>
        <h2>6. Your content</h2>
        <p>
          You retain ownership of research queries, notes, documents, tags, and other content you submit to video2ctx. You grant
          us a limited, worldwide license to host, copy, process, transmit, and display that content only as necessary to operate,
          secure, and improve the service or comply with law. You represent that you have the rights necessary to submit the
          content and instruct us to process it.
        </p>
      </section>

      <section>
        <h2>7. Third-party platforms and public information</h2>
        <p>
          video2ctx is an independent service and is not endorsed by or affiliated with YouTube, Google, or other supported video
          platforms. Platform names and content belong to their respective owners. Your use of connected platforms remains
          subject to their terms and policies.
        </p>
        <p>
          Public metadata, transcripts, comments, and metrics may be incomplete, delayed, changed, removed, or inaccurate. You are
          responsible for determining whether your use of third-party content is lawful, including compliance with copyright,
          privacy, attribution, and platform requirements.
        </p>
      </section>

      <section>
        <h2>8. Acceptable use</h2>
        <p>You may not use video2ctx to:</p>
        <ul>
          <li>Break the law, infringe rights, harass others, or distribute malicious or deceptive material.</li>
          <li>Access accounts, private information, or systems without authorization.</li>
          <li>Bypass rate limits, credit accounting, access controls, or technical restrictions.</li>
          <li>Probe, disrupt, overload, or impair the service or its providers.</li>
          <li>Use automated traffic that exceeds documented API behavior or materially harms service availability.</li>
          <li>Resell or provide shared access to the service without our written permission.</li>
          <li>Use output as a substitute for qualified professional, legal, medical, or financial advice.</li>
        </ul>
      </section>

      <section>
        <h2>9. APIs</h2>
        <p>
          API use is subject to these terms, published documentation, permissions, credit charges, and request limits. We may
          rotate, revoke, or suspend an API key to protect the account or service. You must not include credentials in public code,
          client-side applications, logs, or shared material.
        </p>
      </section>

      <section>
        <h2>10. AI-assisted output</h2>
        <p>
          AI-generated summaries, comparisons, trend observations, plans, and reports can be incorrect, incomplete, or
          misleading. Similar output may be generated for other users. You must review the underlying evidence and use independent
          judgment before relying on or publishing output. video2ctx does not guarantee that output is unique, accurate, or fit
          for a particular purpose.
        </p>
      </section>

      <section>
        <h2>11. video2ctx property</h2>
        <p>
          The service, software, design, documentation, and branding—excluding your content and third-party content—are owned by
          video2ctx or its licensors and protected by applicable law. These terms give you a limited, non-exclusive,
          non-transferable, revocable right to use the service; they do not transfer ownership.
        </p>
      </section>

      <section>
        <h2>12. Availability and changes</h2>
        <p>
          The service is evolving and may experience interruptions, errors, or data loss. We may add, change, suspend, or
          discontinue features, providers, limits, or integrations. We will make reasonable efforts to avoid unnecessary
          disruption but do not promise uninterrupted availability or permanent retention of any feature.
        </p>
      </section>

      <section>
        <h2>13. Suspension and termination</h2>
        <p>
          You may stop using video2ctx and request account deletion. We may suspend or terminate access when reasonably necessary
          to address a violation, security risk, legal requirement, non-payment if paid services are introduced, or material harm
          to the service or others. Provisions that by their nature should survive termination will survive.
        </p>
      </section>

      <section>
        <h2>14. Disclaimers</h2>
        <p>
          To the maximum extent permitted by law, video2ctx is provided “as is” and “as available.” We disclaim implied warranties,
          including merchantability, fitness for a particular purpose, non-infringement, and warranties arising from course of
          dealing. We do not warrant the accuracy, completeness, availability, or continued accessibility of third-party content
          or AI output. Nothing in these terms excludes a warranty or right that cannot legally be excluded.
        </p>
      </section>

      <section>
        <h2>15. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, video2ctx will not be liable for indirect, incidental, special, consequential,
          exemplary, or punitive damages, or for loss of profits, data, goodwill, business opportunities, or service availability,
          arising from or related to the service. Our aggregate liability will not exceed the amount you paid to video2ctx for the
          service during the 12 months before the event giving rise to the claim. These limitations do not apply where prohibited
          by law.
        </p>
      </section>

      <section>
        <h2>16. Changes and contact</h2>
        <p>
          We may update these terms as the service changes. We will update the effective date and provide additional notice when
          required. Continuing to use the service after revised terms take effect constitutes acceptance of the revised terms.
          Questions can be sent to <a href='mailto:privacy@video2ctx.dev'>privacy@video2ctx.dev</a>.
        </p>
      </section>
    </LegalPage>
  );
}
