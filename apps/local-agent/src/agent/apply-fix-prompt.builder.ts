import { Injectable } from '@nestjs/common';
import { collectSecretValues, redactSecretsInText, type AgentTask } from '@amp/core';

@Injectable()
export class ApplyFixPromptBuilder {
  build(task: AgentTask): string {
    const payload = {
      proposalId: task.proposalId,
      approvedProposal: task.approvedProposal,
      issue: task.issue,
      context: task.context,
      allowedFiles: task.allowedFiles,
      constraints: task.constraints,
    };
    const prompt = [
      'Apply the previously approved proposal to the existing project.',
      'Modify only files listed in allowedFiles. Do not expand scope.',
      'Do not modify .env files, credentials, certificates, private keys, Git configuration, CI credentials, or service-account files.',
      'Preserve current architecture and behavior outside the approved change.',
      'Do not run package-manager fixes, Git commands, commits, pushes, deployments, or dependency installation.',
      'Do not run builds, tests, linters, scanners, type checks, or startup commands. The platform runs every validation after you finish.',
      'The platform will inspect the actual Git delta and run validation after you finish.',
      'Return only JSON matching the supplied schema. Never include secrets.',
      '',
      `INPUT:\n${JSON.stringify(payload, null, 2)}`,
    ].join('\n');
    return redactSecretsInText(prompt, collectSecretValues(process.env));
  }
}
