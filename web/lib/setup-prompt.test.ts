import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentNames, buildSetupPrompt, skillsInstallCommand } from './setup-prompt.ts';

describe('setup prompt', () => {
  it('installs the skills for each named agent', () => {
    assert.equal(skillsInstallCommand(['codex', 'claude-code']), "npx skills add devhims/video2ctx --skill '*' -a claude-code -a codex -g -y");
    assert.equal(skillsInstallCommand(['other']), "npx skills add devhims/video2ctx --skill '*' -g -y");
  });

  it('names the chosen agents as prose', () => {
    assert.equal(agentNames(['codex']), 'Codex');
    assert.equal(agentNames(['claude-code', 'codex']), 'Claude Code and Codex');
    assert.equal(agentNames(['cursor', 'claude-code', 'opencode']), 'Claude Code, Cursor, and OpenCode');
    assert.equal(agentNames(['other']), 'your agent');
    assert.equal(agentNames(['codex', 'other']), 'Codex and any other agent');
  });

  it('includes the goal only when one is given', () => {
    assert.match(buildSetupPrompt({ agents: ['codex'], goal: '  A channel digest\n bot ' }), /\*\*What the user is building:\*\* A channel digest bot\n/);
    assert.doesNotMatch(buildSetupPrompt({ agents: ['codex'], goal: '   ' }), /What the user is building/);
  });

  it('tells an unlisted agent how to target itself', () => {
    assert.match(buildSetupPrompt({ agents: ['other'] }), /Add `-a <your-agent-id>`/);
    assert.match(buildSetupPrompt({ agents: ['codex', 'other'] }), /If you are not one of the agents/);
    assert.doesNotMatch(buildSetupPrompt({ agents: ['codex'] }), /your-agent-id/);
  });

  it('never asks for a credential', () => {
    const prompt = buildSetupPrompt({ agents: ['claude-code'] });
    assert.match(prompt, /video2ctx auth login/);
    assert.doesNotMatch(prompt, /aty_/);
  });
});
