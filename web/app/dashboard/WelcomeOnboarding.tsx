'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@vercel/analytics';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { platformRequest } from '../../lib/platform-request';
import { CODING_AGENTS, agentNames, buildSetupPrompt, type CodingAgentId } from '../../lib/setup-prompt';
import { Checkbox } from './Checkbox';
import { useAccountResource } from './DashboardDataProvider';
import { useDialogFocus } from './use-dialog-focus';
import styles from './WelcomeOnboarding.module.css';

type Step = 'agents' | 'goal' | 'prompt';

/** Asks a new account which coding agents it uses and what it is building, then hands it a setup prompt. */
export function WelcomeOnboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('agents');
  const [agents, setAgents] = useState<CodingAgentId[]>([]);
  const [goal, setGoal] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const prompt = useMemo(() => buildSetupPrompt({ agents, goal }), [agents, goal]);
  const { data: usage } = useAccountResource('usage', null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onDone);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const promptRef = useRef<HTMLPreElement>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const reported = useRef(false);
  const savedAnswers = useRef('');

  // Move focus with the step: into the goal field so typing works at once, otherwise to the new heading.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const field = step === 'goal' ? goalRef.current : null;
    if (!field) { headingRef.current?.focus(); return; }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [step]);

  const toggle = (agent: CodingAgentId, checked: boolean) =>
    setAgents(current => checked ? [...current, agent] : current.filter(id => id !== agent));

  const showPrompt = () => {
    setCopy('idle');
    setStep('prompt');
    // Best effort: the prompt never waits on this, and a failed save loses only the answers.
    const answers = JSON.stringify({ agents, goal: goal.trim() || null });
    if (answers !== savedAnswers.current) {
      savedAnswers.current = answers;
      platformRequest('/v1/onboarding', { method: 'PUT', body: answers }).catch(() => { savedAnswers.current = ''; });
    }
    if (reported.current) return;
    reported.current = true;
    for (const agent of agents) track('Coding agent selected', { agent });
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopy('copied');
      track('Setup prompt copied');
    } catch {
      // Clipboard access can be refused; select the text so a manual copy is one keystroke.
      setCopy('failed');
      const range = document.createRange();
      if (promptRef.current) range.selectNodeContents(promptRef.current);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  };

  const brand = <p className={styles.brand}><img src='/brand/logo-120.png' width='28' height='28' alt='' />video2ctx</p>;

  return <div className={styles.backdrop}>
    <div
      ref={dialogRef}
      className={styles.card}
      data-wide={step === 'prompt'}
      role='dialog'
      aria-modal='true'
      aria-labelledby='welcome-title'
    >
      {step === 'agents' && <form key='agents' className={styles.step} onSubmit={event => { event.preventDefault(); if (agents.length) setStep('goal'); }}>
        {brand}
        <p className={styles.eyebrow}>Step 1 of 3</p>
        <h2 id='welcome-title' ref={headingRef} tabIndex={-1}>Which coding agents do you use?</h2>
        <p className={styles.lede}>Select all that apply. We will tailor a setup prompt to them.</p>
        <fieldset className={styles.agents}>
          <legend className={styles.visuallyHidden}>Coding agents</legend>
          {CODING_AGENTS.map(agent => <Checkbox
            key={agent.id}
            className={styles.agent}
            label={agent.label}
            checked={agents.includes(agent.id)}
            onCheckedChange={checked => toggle(agent.id, checked)}
          />)}
        </fieldset>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={!agents.length}>Continue</button>
        </div>
        <button type='button' className={styles.skip} onClick={onDone}>Skip for now</button>
      </form>}

      {step === 'goal' && <form key='goal' className={styles.step} onSubmit={event => { event.preventDefault(); showPrompt(); }}>
        {brand}
        <p className={styles.eyebrow}>Step 2 of 3</p>
        <h2 id='welcome-title' ref={headingRef} tabIndex={-1}>What are you building?</h2>
        <p id='welcome-goal-note' className={styles.lede}>Optional. Your agent starts with this context.</p>
        <label className={styles.visuallyHidden} htmlFor='welcome-goal'>What you are building</label>
        <textarea
          id='welcome-goal'
          ref={goalRef}
          aria-describedby='welcome-goal-note'
          className={styles.goal}
          maxLength={500}
          rows={4}
          value={goal}
          onChange={event => setGoal(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); showPrompt(); } }}
          placeholder='e.g. A research agent that summarizes new videos from channels I follow'
        />
        <div className={styles.actions}>
          <button type='button' className={styles.secondary} onClick={() => setStep('agents')}>Back</button>
          <button className={styles.primary}>Generate setup prompt</button>
        </div>
      </form>}

      {step === 'prompt' && <div key='prompt' className={`${styles.step} ${styles.done}`}>
        <div className={styles.intro}>
          {brand}
          <h2 id='welcome-title' ref={headingRef} tabIndex={-1}>You&rsquo;re all set</h2>
          <p className={styles.lede}>Paste this prompt into {agentNames(agents)}. It installs the video2ctx skills, signs the CLI in to your account, and makes one test call.</p>
          <button type='button' className={styles.back} onClick={() => setStep('goal')}>← Change answers</button>
        </div>
        <div className={styles.panel}>
          <div className={styles.promptHead}><span>Setup prompt</span><span>For {agentNames(agents)}</span></div>
          <pre ref={promptRef} className={styles.prompt} tabIndex={0} aria-label='Setup prompt'>{prompt}</pre>
          <button type='button' className={styles.primary} onClick={() => void copyPrompt()}>
            {copy === 'copied' ? <CheckIcon size={16} weight='bold' aria-hidden='true' /> : <CopyIcon size={16} aria-hidden='true' />}
            {copy === 'copied' ? 'Copied' : 'Copy setup prompt'}
          </button>
          <p className={styles.copyStatus} role='status'>{copy === 'failed' ? 'Copy was blocked. The prompt is selected; press ⌘C or Ctrl+C.' : ''}</p>
          <button type='button' className={styles.secondary} onClick={onDone}>Go to dashboard</button>
          {typeof usage?.creditBalance === 'number' && <p className={styles.credits}>{usage.creditBalance.toLocaleString('en-US')} credits available</p>}
        </div>
      </div>}
    </div>
  </div>;
}
