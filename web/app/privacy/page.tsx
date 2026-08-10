import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';
import styles from '../legal-page.module.css';

export const metadata: Metadata = {
  title: 'Privacy Policy · video2ctx',
  description: 'How video2ctx collects, uses, protects, and deletes personal information and Google user data.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow='Your information'
      title='Privacy policy'
      effectiveDate='August 10, 2026'
      summary='This policy explains what video2ctx collects, why we use it, who processes it, and the controls available to you.'
    >
      <section>
        <h2>1. About video2ctx</h2>
        <p>
          video2ctx is a research service for finding, organizing, monitoring, and analysing video information. In this policy,
          “video2ctx,” “we,” and “us” refer to the operator of the video2ctx service available at video2ctx.dev.
        </p>
      </section>

      <section>
        <h2>2. Information we collect</h2>
        <h3>Account and authentication information</h3>
        <p>
          When you sign in, we may receive your name, email address, profile image, provider account identifier, and email
          verification status. We also process session identifiers, IP address, browser or device information, and authentication
          events to operate and protect your account.
        </p>
        <h3>Research and workspace information</h3>
        <p>
          We store information you submit or create, including searches, URLs, projects, notes, tags, imported documents,
          monitoring preferences, exports, generated reports, and other research inputs and outputs.
        </p>
        <h3>Video-platform information</h3>
        <p>
          We process public video, channel, playlist, transcript, comment, and engagement information obtained from supported
          platforms or public sources. If you explicitly connect a YouTube account, we also process the authorization described
          in the Google user data section below.
        </p>
        <h3>API keys and service activity</h3>
        <p>
          We store an API key name, prefix, hashed credential, permissions, creation and last-use information, and request
          counters. The complete secret is displayed only when it is created. We also process request identifiers, route,
          response status, duration, credit usage, and security events. We do not intentionally place raw API keys, session
          cookies, authorization headers, or email addresses in application access logs.
        </p>
        <h3>Website analytics</h3>
        <p>
          We use Vercel Analytics to understand aggregate website usage and performance. Vercel may process technical details
          such as the page visited, referring page, device or browser information, and an approximate location derived from a
          network address in accordance with its own privacy documentation.
        </p>
      </section>

      <section>
        <h2>3. How we use information</h2>
        <ul>
          <li>Provide authentication, research, search, analysis, monitoring, export, and API functionality.</li>
          <li>Associate saved work, credits, preferences, connected accounts, and API keys with the correct user.</li>
          <li>Generate evidence-linked summaries, comparisons, trend insights, and reports.</li>
          <li>Maintain caches, prevent duplicate work, enforce limits, and measure service usage.</li>
          <li>Detect abuse, protect accounts, troubleshoot failures, and improve reliability.</li>
          <li>Send requested sign-in links and enabled service notifications.</li>
          <li>Comply with legal obligations and enforce our terms.</li>
        </ul>
      </section>

      <section>
        <h2>4. Google user data</h2>
        <h3>Google sign-in</h3>
        <p>
          Google sign-in requests only OpenID identity information: your Google account identifier, basic profile information,
          and primary email address. We use this information to create, secure, and display your video2ctx account.
        </p>
        <h3>Connected YouTube accounts</h3>
        <p>
          Connecting YouTube is optional and uses the read-only YouTube scope. When you choose to connect, video2ctx receives
          permission to view information associated with your YouTube account. We store an encrypted refresh token so the
          requested connection can continue without asking you to sign in each time. We do not use this permission to publish,
          edit, or delete videos.
        </p>
        <p>
          You can disconnect YouTube from video2ctx or revoke access from your Google Account permissions. On disconnect, we
          attempt to revoke the Google token and delete the stored connection. Account deletion also removes the stored
          connection.
        </p>
        <p className={styles.notice}>
          video2ctx’s use and transfer of information received from Google APIs adheres to the{' '}
          <a href='https://developers.google.com/terms/api-services-user-data-policy' rel='noreferrer'>
            Google API Services User Data Policy
          </a>, including the Limited Use requirements.
        </p>
      </section>

      <section>
        <h2>5. AI-assisted features</h2>
        <p>
          When you request an AI-assisted analysis, relevant prompts, research inputs, and evidence excerpts are processed by
          Cloudflare’s AI infrastructure and the selected model so the feature can return a result. Do not include sensitive
          personal information that is unnecessary for your research. AI output may be incomplete or inaccurate and should be
          checked against the cited source material.
        </p>
      </section>

      <section>
        <h2>6. When information is shared</h2>
        <p>We do not sell personal information. We disclose information only as needed to:</p>
        <ul>
          <li>
            Operate the service through infrastructure providers, including Cloudflare for compute, storage, security, email,
            and AI services, and Vercel for website hosting and analytics.
          </li>
          <li>Interact with Google and supported video platforms when you request their functionality.</li>
          <li>Comply with law, legal process, or valid governmental requests.</li>
          <li>Protect users, the public, video2ctx, or our legal rights from fraud, abuse, or security threats.</li>
          <li>Complete a merger, financing, acquisition, or transfer of the service, subject to appropriate safeguards.</li>
        </ul>
      </section>

      <section>
        <h2>7. Cookies and similar technologies</h2>
        <p>
          video2ctx uses secure authentication cookies to keep you signed in and protect account actions. The service may also
          use local browser storage for interface preferences. Vercel Analytics processes usage signals as described above.
          Blocking essential authentication storage may prevent account features from working.
        </p>
      </section>

      <section>
        <h2>8. Storage, retention, and deletion</h2>
        <p>
          Account and workspace information is generally retained while your account remains active. Connected-account tokens
          are retained until you disconnect the provider, delete your account, or the connection is otherwise revoked. Cached
          public video information is retained according to operational cache periods and may be refreshed or deleted over time.
        </p>
        <p>
          When an account is deleted, video2ctx deletes the account’s database records, private stored objects, connected-account
          authorization, and private search index through its deletion workflow. Limited records may remain temporarily in
          backups, security logs, delivery records, or where retention is required by law. We retain such residual information
          only for the applicable operational or legal period and do not use it for unrelated purposes.
        </p>
      </section>

      <section>
        <h2>9. Security</h2>
        <p>
          We use measures designed to protect information, including encrypted connections, hashed API keys and verification
          tokens, encrypted connected-account refresh tokens, access controls, request limits, and secrets managed outside the
          source code. No online service can guarantee absolute security.
        </p>
      </section>

      <section>
        <h2>10. Your choices and rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, export, object to processing of, or delete personal
          information. You may revoke API keys, change notification preferences, disconnect YouTube, revoke Google access, or
          request account deletion. Contact us if you cannot exercise a request through the product. We may need to verify your
          identity before completing a request.
        </p>
      </section>

      <section>
        <h2>11. International processing</h2>
        <p>
          video2ctx and its service providers may process information in countries other than your own. Those countries may have
          different data-protection laws. Where required, we rely on appropriate safeguards for these transfers.
        </p>
      </section>

      <section>
        <h2>12. Children</h2>
        <p>
          video2ctx is intended for adults and is not directed to children under 18. If you believe a child has provided personal
          information, contact us so we can investigate and delete it where appropriate.
        </p>
      </section>

      <section>
        <h2>13. Changes and contact</h2>
        <p>
          We may update this policy as the service changes. We will revise the effective date and provide additional notice when
          required. Questions or privacy requests can be sent to{' '}
          <a href='mailto:privacy@video2ctx.dev'>privacy@video2ctx.dev</a>.
        </p>
      </section>
    </LegalPage>
  );
}
