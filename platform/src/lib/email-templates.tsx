import type { CSSProperties, ReactElement, ReactNode } from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
  render,
  toPlainText,
} from 'react-email';

export interface MonitorAlertEmailData {
  recipientName: string;
  monitorLabel: string;
  videoTitle: string;
  videoUrl: string;
  settingsUrl: string;
  unsubscribeUrl: string;
}

export interface NotificationOptInEmailData {
  recipientName: string;
  confirmationUrl: string;
}

export interface DigestEmailData {
  recipientName: string;
  cadence: 'daily' | 'weekly';
  notifications: Array<{ title: string; body: string }>;
  dashboardUrl: string;
  unsubscribeUrl: string;
}

export async function renderMonitorAlertEmail(data: MonitorAlertEmailData): Promise<{ html: string; text: string }> {
  return renderEmail(<MonitorAlertEmail {...data} />);
}

export async function renderNotificationOptInEmail(data: NotificationOptInEmailData): Promise<{ html: string; text: string }> {
  return renderEmail(<NotificationOptInEmail {...data} />);
}

export async function renderDigestEmail(data: DigestEmailData): Promise<{ html: string; text: string }> {
  return renderEmail(<DigestEmail {...data} />);
}

export function MonitorAlertEmail({ recipientName, monitorLabel, videoTitle, videoUrl, settingsUrl, unsubscribeUrl }: MonitorAlertEmailData) {
  return <EmailShell preview={`New video from ${monitorLabel}: ${videoTitle}`}>
    <Text style={eyebrow}>NEW MONITOR MATCH</Text>
    <Heading style={heading}>A new video appeared from {monitorLabel}</Heading>
    <Text style={bodyText}>Hello {recipientName},</Text>
    <Text style={bodyText}>Your channel monitor found a new public upload.</Text>
    <Section style={highlight}>
      <Text style={highlightLabel}>{monitorLabel}</Text>
      <Text style={videoTitleStyle}>{videoTitle}</Text>
    </Section>
    <Button href={videoUrl} style={primaryButton}>Watch on YouTube</Button>
    <Text style={supportingText}>You received this because you created a monitor in video2ctx. Email alerts are sent to the address on your video2ctx account.</Text>
    <Hr style={rule} />
    <Text style={footerText}><Link href={settingsUrl} style={footerLink}>Notification settings</Link> · <Link href={unsubscribeUrl} style={footerLink}>Turn off email alerts</Link></Text>
  </EmailShell>;
}

export function NotificationOptInEmail({ recipientName, confirmationUrl }: NotificationOptInEmailData) {
  return <EmailShell preview='Confirm email alerts for your video2ctx monitors'>
    <Text style={eyebrow}>CONFIRM EMAIL ALERTS</Text>
    <Heading style={heading}>Approve monitor emails</Heading>
    <Text style={bodyText}>Hello {recipientName},</Text>
    <Text style={bodyText}>You asked to receive email when a video2ctx monitor finds a new upload.</Text>
    <Button href={confirmationUrl} style={primaryButton}>Review and confirm</Button>
    <Text style={supportingText}>Email alerts remain off until you return to the signed-in dashboard and confirm. If you did not request this, you can ignore this message.</Text>
  </EmailShell>;
}

export function DigestEmail({ recipientName, cadence, notifications, dashboardUrl, unsubscribeUrl }: DigestEmailData) {
  return <EmailShell preview={`Your ${cadence} video2ctx monitor digest`}>
    <Text style={eyebrow}>{cadence.toUpperCase()} DIGEST</Text>
    <Heading style={heading}>Your recent monitor matches</Heading>
    <Text style={bodyText}>Hello {recipientName}, here are the new videos detected by your monitors.</Text>
    {notifications.map((notification, index) => <Section key={`${notification.title}-${index}`} style={digestItem}>
      <Text style={highlightLabel}>{notification.title}</Text>
      <Text style={digestBody}>{notification.body}</Text>
    </Section>)}
    <Button href={dashboardUrl} style={primaryButton}>Open video2ctx</Button>
    <Hr style={rule} />
    <Text style={footerText}><Link href={unsubscribeUrl} style={footerLink}>Turn off email alerts</Link></Text>
  </EmailShell>;
}

function EmailShell({ preview, children }: { preview: string; children: ReactNode }) {
  return <Html lang='en'>
    <Head />
    <Preview>{preview}</Preview>
    <Body style={page}>
      <Container style={container}>
        <Text style={brand}>video2<span style={brandAccent}>ctx</span></Text>
        {children}
      </Container>
    </Body>
  </Html>;
}

async function renderEmail(component: ReactElement): Promise<{ html: string; text: string }> {
  const html = await render(component, { pretty: true });
  return { html, text: toPlainText(html) };
}

const page: CSSProperties = { margin: 0, padding: '36px 12px', backgroundColor: '#f1efe9', color: '#171714', fontFamily: 'Arial, Helvetica, sans-serif' };
const container: CSSProperties = { maxWidth: '560px', margin: '0 auto', padding: '34px', border: '1px solid #dedbd2', borderRadius: '12px', backgroundColor: '#fffefb' };
const brand: CSSProperties = { margin: '0 0 36px', color: '#171714', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.6px' };
const brandAccent: CSSProperties = { color: '#d84c3f' };
const eyebrow: CSSProperties = { margin: '0 0 10px', color: '#a53d33', fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px' };
const heading: CSSProperties = { margin: '0 0 22px', color: '#171714', fontSize: '28px', lineHeight: '34px', letterSpacing: '-1px' };
const bodyText: CSSProperties = { margin: '0 0 14px', color: '#55554f', fontSize: '15px', lineHeight: '24px' };
const highlight: CSSProperties = { margin: '24px 0', padding: '20px', borderLeft: '3px solid #d84c3f', backgroundColor: '#f7f4ee' };
const highlightLabel: CSSProperties = { margin: '0 0 8px', color: '#77766f', fontSize: '11px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase' };
const videoTitleStyle: CSSProperties = { margin: 0, color: '#171714', fontSize: '18px', fontWeight: 700, lineHeight: '26px' };
const primaryButton: CSSProperties = { margin: '4px 0 24px', padding: '13px 18px', borderRadius: '7px', backgroundColor: '#d84c3f', color: '#ffffff', fontSize: '14px', fontWeight: 700, textDecoration: 'none' };
const supportingText: CSSProperties = { margin: '4px 0 22px', color: '#77766f', fontSize: '12px', lineHeight: '19px' };
const rule: CSSProperties = { margin: '24px 0 16px', borderColor: '#dedbd2' };
const footerText: CSSProperties = { margin: 0, color: '#77766f', fontSize: '12px', lineHeight: '19px' };
const footerLink: CSSProperties = { color: '#55554f', textDecoration: 'underline' };
const digestItem: CSSProperties = { margin: '12px 0', padding: '15px 17px', border: '1px solid #e5e1d8', borderRadius: '8px', backgroundColor: '#faf8f3' };
const digestBody: CSSProperties = { margin: 0, color: '#171714', fontSize: '14px', fontWeight: 600, lineHeight: '21px' };
