import type { CSSProperties, ReactNode } from 'react';
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from 'react-email';

export interface WelcomeEmailData {
  recipientName: string;
  starterCredits: number;
  dashboardUrl: string;
  agentUrl: string;
  /** Origin of the web app, which serves the logo. */
  assetOrigin: string;
}

const DOCS_URL = 'https://docs.video2ctx.dev';
const API_REFERENCE_URL = 'https://docs.video2ctx.dev/api-reference/introduction';
const GITHUB_URL = 'https://github.com/devhims/video2ctx';
const LICENSE_URL = 'https://github.com/devhims/video2ctx/blob/main/LICENSE';
const CLI_SETUP_URL = 'https://docs.video2ctx.dev/skills/installation';
const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/all-things-youtube';

// Parked with the "Context you can check" section in the body.
// /* Adapted from the homepage's "Context you can check" section. */
// const BENEFITS = [
//   { title: 'Every moment keeps its source', body: 'Each transcript line links to the second it was said, so an answer can be checked instead of taken on trust.' },
//   { title: 'Missing data says so', body: 'Captions off or comments disabled? Your agent is told plainly, rather than guessing from an empty result.' },
//   { title: 'Nothing is locked in', body: 'Apache 2.0. Use the hosted version, install the package, or run all of it yourself.' },
//   { title: 'YouTube first, not YouTube only', body: 'New sources slot in beside YouTube without changing the shape of what you have built.' },
// ];

/* Light is the inline default because it is what clients without dark-mode
 * support render. Dark mirrors the homepage's Craft palette and is applied by
 * class, so every override needs !important to beat the inline style. Values
 * are hex conversions of web/tokens.css (--color-home-* for light) and
 * web/app/craft.css (dark); email clients do not support oklch(). */
const light = {
  page: '#f7f3eb',
  card: '#fdfaf4',
  inset: '#f3eee5',
  rule: '#dfdad2',
  ink: '#191510',
  soft: '#534f49',
  muted: '#646059',
  accent: '#e9523c',
  accentText: '#b8402c',
  accentInk: '#17130e',
};

const dark = {
  page: '#0e0c09',
  card: '#161310',
  inset: '#1e1b18',
  rule: '#292622',
  ink: '#f0eeea',
  soft: '#a7a49f',
  muted: '#898681',
  accent: '#f05943',
  accentInk: '#13110f',
};

/* Code stays dark in both schemes, as it does on the homepage. */
const codeSurface = { background: '#1e1b18', border: '#292622', ink: '#f0eeea', prompt: '#898681' };

const darkRules = `
.v-page{background-color:${dark.page}!important}
.v-card{background-color:${dark.card}!important;border-color:${dark.rule}!important}
.v-inset{background-color:${dark.inset}!important;border-color:${dark.rule}!important}
.v-rule{border-color:${dark.rule}!important}
.v-ink{color:${dark.ink}!important}
.v-soft{color:${dark.soft}!important}
.v-muted{color:${dark.muted}!important}
.v-accent{color:${dark.accent}!important}
.v-button{background-color:${dark.accent}!important;color:${dark.accentInk}!important}
.v-code{background-color:${dark.page}!important}`;

/* Apple Mail, iOS Mail and Outlook for Mac honour the media query. Outlook.com
 * marks its dark mode with data-ogsc (text) and data-ogsb (backgrounds). Gmail
 * ignores both and applies its own inversion to the light default. */
const prefixRules = (prefix: string) => darkRules.trim().split('\n').map((rule) => `${prefix} ${rule}`).join('\n');
const headStyles = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){${darkRules}}
${prefixRules('[data-ogsc]')}
${prefixRules('[data-ogsb]')}
@media only screen and (max-width:620px){.v-card{padding:28px 22px!important}.v-hero{font-size:34px!important;line-height:38px!important}}`;

export function WelcomeEmail({ recipientName, starterCredits, dashboardUrl, agentUrl, assetOrigin }: WelcomeEmailData) {
  const credits = starterCredits.toLocaleString('en-US');
  const firstName = recipientName.trim().split(/\s+/)[0];
  return <Html lang='en' dir='ltr'>
    <Head>
      <meta name='color-scheme' content='light dark' />
      <meta name='supported-color-schemes' content='light dark' />
      <link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap' />
      <style>{headStyles}</style>
    </Head>
    <Preview>{`A note from Himanshu, plus ${credits} free credits to start.`}</Preview>
    {/* Body copies its style onto an inner cell the dark class cannot reach, so
        the page colour and spacing live on a classed wrapper instead. */}
    <Body className='v-page' style={{ margin: 0, backgroundColor: light.page }}>
      <Section className='v-page' style={page}>
        <Container className='v-card' style={card}>
          <Row style={{ marginBottom: '40px' }}>
            <Column style={{ width: '40px', verticalAlign: 'middle' }}>
              <Img src={`${assetOrigin}/apple-icon.png`} width='28' height='28' alt='video2ctx' style={logo} />
            </Column>
            <Column style={{ verticalAlign: 'middle' }}>
              <Text className='v-ink' style={wordmark}>video2<span className='v-soft' style={wordmarkCtx}>ctx</span></Text>
            </Column>
          </Row>

          <Heading as='h1' className='v-ink v-hero' style={hero}>
            Video in. Context out.
          </Heading>
          <Text className='v-soft' style={lede}>{firstName ? `Welcome to video2ctx, ${firstName}.` : 'Welcome to video2ctx.'}</Text>

          <Text className='v-ink' style={body}>{firstName ? `Hi ${firstName},` : 'Hi there,'}</Text>
          <Text className='v-ink' style={body}>
            I'm Himanshu, the developer behind video2ctx. Thank you for signing up. It genuinely means a lot that you're giving it a try!
          </Text>
          <Text className='v-ink' style={body}>
            I built video2ctx because agents are still bad at video. They either can't watch it, or burn minutes and a pile of tokens to answer one question. video2ctx gives your agent exactly what it needs to understand and answer questions from a video, using about 95% fewer tokens.
          </Text>

          {/* Parked with BENEFITS above; may return in a later version.
          <Text className='v-ink' style={{ ...sectionTitle, margin: '30px 0 14px' }}>Context you can check</Text>
          {BENEFITS.map((benefit) => <Section key={benefit.title} style={benefitRow}>
            <Text className='v-ink' style={benefitTitle}><span className='v-accent' style={benefitMark}>■</span>{benefit.title}</Text>
            <Text className='v-soft' style={benefitBody}>{benefit.body}</Text>
          </Section>)}
          */}

          <Section className='v-inset' style={creditsPanel}>
            <Text className='v-accent' style={eyebrow}>Starter credits</Text>
            <Text className='v-ink' style={creditsFigure}>{credits} free credits</Text>
            <Text className='v-soft' style={creditsNote}>Already in your account, no card needed.</Text>
          </Section>

          <Text className='v-ink' style={sectionTitle}>Get started your way</Text>

          <Step index='01' title='Video Agent' badge='New'>
            <Text className='v-soft' style={stepText}>Ask a question and it finds and watches the videos for you.</Text>
            <Link href={agentUrl} className='v-accent' style={actionLink}>Try Video Agent →</Link>
          </Step>

          <Step index='02' title='Agent Skills'>
            <Text className='v-soft' style={stepText}>Use it with Claude Code, Codex or any agent that loads skills, free of charge.</Text>
            <Code lines={['npx skills add devhims/video2ctx']} />
          </Step>

          <Step index='03' title='CLI + Skill' last>
            <Text className='v-soft' style={stepText}>Anything you can do in the dashboard, you can also do from the terminal.</Text>
            <Link href={CLI_SETUP_URL} className='v-accent' style={actionLink}>Set up the CLI →</Link>
          </Step>

          <Text className='v-soft' style={developerNote}>
            Building an app? See the <Link href={API_REFERENCE_URL} className='v-accent' style={inlineLink}>API reference</Link> or <Link href={NPM_PACKAGE_URL} className='v-accent' style={inlineLink}>all-things-youtube</Link> on npm.
          </Text>

          <Button href={dashboardUrl} className='v-button' style={button}>Open your dashboard</Button>

          <Text className='v-ink' style={body}>
            If you have any feedback or questions, or you're building something with video, just reply. It comes straight to me.
          </Text>

                    <Text className='v-ink' style={signature}>Himanshu Gupta</Text>
          <Text className='v-muted' style={signatureRole}>Founder, video2ctx</Text>

          <Hr className='v-rule' style={rule} />
          <Text className='v-muted' style={footer}>
            You're receiving this one-time email because you created a video2ctx account.
          </Text>
          <Text className='v-muted' style={footer}>
            <Link href={DOCS_URL} className='v-muted' style={footerLink}>Docs</Link>{'  ·  '}
            <Link href={GITHUB_URL} className='v-muted' style={footerLink}>GitHub</Link>{'  ·  '}
            <Link href={dashboardUrl} className='v-muted' style={footerLink}>Dashboard</Link>{'  ·  '}
            <Link href={LICENSE_URL} className='v-muted' style={footerLink}>Apache 2.0</Link>
          </Text>
        </Container>
      </Section>
    </Body>
  </Html>;
}

function Step({ index, title, badge, last, children }: { index: string; title: string; badge?: string; last?: boolean; children: ReactNode }) {
  return <Section className='v-rule' style={{ ...step, ...(last ? { borderBottom: `1px solid ${light.rule}` } : {}) }}>
    <Row>
      <Column style={{ width: '40px', verticalAlign: 'top' }}>
        <Text className='v-muted' style={stepIndex}>{index}</Text>
      </Column>
      <Column style={{ verticalAlign: 'top' }}>
        <Text className='v-ink' style={stepTitle}>
          {title}
          {badge ? <>{' '}<span style={badgeStyle}>{badge.toUpperCase()}</span></> : null}
        </Text>
        {children}
      </Column>
    </Row>
  </Section>;
}

function Code({ lines }: { lines: string[] }) {
  return <Section className='v-code' style={codeBlock}>
    {lines.map((line) => <Text key={line} style={codeLine}><span style={codePrompt}>$ </span>{line}</Text>)}
  </Section>;
}

const sans = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const page: CSSProperties = { padding: '40px 12px', backgroundColor: light.page, fontFamily: sans, WebkitFontSmoothing: 'antialiased' };
const card: CSSProperties = { maxWidth: '600px', margin: '0 auto', padding: '40px 44px', border: `1px solid ${light.rule}`, borderRadius: '16px', backgroundColor: light.card };
const logo: CSSProperties = { display: 'block', borderRadius: '7px' };
const wordmark: CSSProperties = { margin: 0, color: light.ink, fontSize: '18px', fontWeight: 700, letterSpacing: '-0.6px', lineHeight: '28px' };
const wordmarkCtx: CSSProperties = { marginLeft: '1px', color: light.soft, fontFamily: mono, fontWeight: 500, letterSpacing: 0 };
const hero: CSSProperties = { margin: '0 0 10px', color: light.ink, fontSize: '42px', fontWeight: 700, lineHeight: '46px', letterSpacing: '-1.8px' };
const lede: CSSProperties = { margin: '0 0 36px', color: light.soft, fontSize: '17px', lineHeight: '26px' };
const body: CSSProperties = { margin: '0 0 18px', color: light.ink, fontSize: '15px', lineHeight: '25px' };
const eyebrow: CSSProperties = { margin: '0 0 8px', color: light.accentText, fontFamily: mono, fontSize: '11px', fontWeight: 500, letterSpacing: '1.2px', lineHeight: '16px', textTransform: 'uppercase' };
// Parked with the "Context you can check" section.
// const benefitRow: CSSProperties = { margin: '0 0 14px' };
// const benefitTitle: CSSProperties = { margin: '0 0 2px', color: light.ink, fontSize: '15px', fontWeight: 600, lineHeight: '22px' };
// const benefitMark: CSSProperties = { marginRight: '9px', color: light.accentText, fontSize: '9px', verticalAlign: '2px' };
// const benefitBody: CSSProperties = { margin: '0 0 0 18px', color: light.soft, fontSize: '14px', lineHeight: '22px' };
const creditsPanel: CSSProperties = { margin: '30px 0 38px', padding: '22px 24px', border: `1px solid ${light.rule}`, borderRadius: '12px', backgroundColor: light.inset };
const creditsFigure: CSSProperties = { margin: '0 0 6px', color: light.ink, fontSize: '26px', fontWeight: 700, lineHeight: '32px', letterSpacing: '-0.9px' };
const creditsNote: CSSProperties = { margin: 0, color: light.soft, fontSize: '14px', lineHeight: '22px' };
const sectionTitle: CSSProperties = { margin: '0 0 6px', color: light.ink, fontSize: '20px', fontWeight: 700, lineHeight: '28px', letterSpacing: '-0.5px' };
const developerNote: CSSProperties = { margin: '22px 0 26px', color: light.soft, fontSize: '14px', lineHeight: '22px' };
const step: CSSProperties = { padding: '20px 0', borderTop: `1px solid ${light.rule}` };
const stepIndex: CSSProperties = { margin: '1px 0 0', color: light.muted, fontFamily: mono, fontSize: '12px', lineHeight: '22px' };
const stepTitle: CSSProperties = { margin: '0 0 6px', color: light.ink, fontSize: '16px', fontWeight: 600, lineHeight: '22px', letterSpacing: '-0.2px' };
const stepText: CSSProperties = { margin: '0 0 12px', color: light.soft, fontSize: '14px', lineHeight: '22px' };
const badgeStyle: CSSProperties = { display: 'inline-block', marginLeft: '4px', padding: '1px 5px', borderRadius: '4px', backgroundColor: light.accent, color: light.accentInk, fontSize: '10px', fontWeight: 800, letterSpacing: '0.4px', lineHeight: '15px', verticalAlign: '2px' };
const actionLink: CSSProperties = { color: light.accentText, fontSize: '14px', fontWeight: 600, lineHeight: '22px', textDecoration: 'none' };
const inlineLink: CSSProperties = { color: light.accentText, textDecoration: 'underline' };
const codeBlock: CSSProperties = { margin: '0 0 12px', padding: '12px 14px', border: `1px solid ${codeSurface.border}`, borderRadius: '8px', backgroundColor: codeSurface.background };
const codeLine: CSSProperties = { margin: 0, color: codeSurface.ink, fontFamily: mono, fontSize: '13px', lineHeight: '22px', overflowWrap: 'anywhere' };
const codePrompt: CSSProperties = { color: codeSurface.prompt, userSelect: 'none' };
const button: CSSProperties = { margin: '6px 0 34px', padding: '13px 20px', borderRadius: '8px', backgroundColor: light.accent, color: light.accentInk, fontSize: '14px', fontWeight: 700, lineHeight: '20px', textDecoration: 'none' };
const signature: CSSProperties = { margin: '28px 0 0', color: light.ink, fontSize: '16px', fontWeight: 700, lineHeight: '24px' };
const signatureRole: CSSProperties = { margin: 0, color: light.muted, fontSize: '13px', lineHeight: '20px' };
const rule: CSSProperties = { margin: '36px 0 18px', border: 'none', borderTop: `1px solid ${light.rule}` };
const footer: CSSProperties = { margin: '0 0 6px', color: light.muted, fontSize: '12px', lineHeight: '19px' };
const footerLink: CSSProperties = { color: light.muted, textDecoration: 'underline' };
