import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONFIRM_TOOL } from '../../../application/proposals/proposalMessages.js';
import { toolNameFor } from '../tools/toolNaming.js';

const periodArgs = {
  period: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe(
      'The period to look at, in your own words (for example "last night"). Default: the last 7 days.'
    ),
};

const userMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

const lines = (...parts: string[]) => parts.join('\n');

const PARTIAL_DATA =
  'If a route comes with `error` or a list with `truncated: true`, say the data is partial: do not state totals or absences from it.';

/**
 * Los prompts del servidor: las tareas más habituales, ya escritas, para que el usuario las elija
 * en su cliente. Solo devuelven texto: no llaman al backend ni cambian nada, y por eso no pasan por
 * la auditoría ni el límite de las herramientas.
 */
export function registerGuidancePrompts(server: McpServer): void {
  server.registerPrompt(
    'patroltech_review_missed_rounds',
    {
      title: 'Review missed rounds',
      description:
        'Which rounds were not completed, on which routes, and which checkpoints were skipped.',
      argsSchema: periodArgs,
    },
    ({ period }) =>
      userMessage(
        lines(
          `Review my PatrolTech rounds for ${period || 'the last 7 days'}.`,
          `Start with ${toolNameFor('rounds.get_status')} and ${toolNameFor('rounds.list_by_route')}. For each incomplete round, use ${toolNameFor('rounds.get_round')} to see which checkpoints were skipped.`,
          'Tell me which rounds were not completed, on which route, with which guard, and what was missing, most recent first.',
          PARTIAL_DATA
        )
      )
  );

  server.registerPrompt(
    'patroltech_review_suspicious_scans',
    {
      title: 'Review suspicious scans',
      description: 'Scans that were rejected, are pending review or look suspicious, and why.',
      argsSchema: periodArgs,
    },
    ({ period }) =>
      userMessage(
        lines(
          `Review the suspicious, rejected or pending PatrolTech scans of ${period || 'the last 7 days'}.`,
          `Use ${toolNameFor('scans.list_recent')}, and ${toolNameFor('scans.count_by_patroller')} to see how they are distributed.`,
          'Explain each scan only from its `validation` and `suspicionReasons`. They are independent: a valid scan can be suspicious.',
          'These are activity counts, not an assessment of anyone: do not draw conclusions about a guard on your own.',
          PARTIAL_DATA
        )
      )
  );

  server.registerPrompt(
    'patroltech_weekly_summary',
    {
      title: 'Weekly summary',
      description: 'How the last week went: rounds, incidents and checkpoints nobody is scanning.',
    },
    () =>
      userMessage(
        lines(
          'Give me a summary of the last week in PatrolTech.',
          `Use ${toolNameFor('account.get_summary')} for the overview, ${toolNameFor('incidents.list')} for what is still open and ${toolNameFor('checkpoints.list_unreviewed')} for the checkpoints that have gone longest without a scan.`,
          'Start with what needs my attention, then the rest, briefly.',
          PARTIAL_DATA
        )
      )
  );

  server.registerPrompt(
    'patroltech_set_up_account',
    {
      title: 'Set up my account',
      description: 'What is missing to get the account running, and help with the next step.',
    },
    () =>
      userMessage(
        lines(
          'Help me get my PatrolTech account running.',
          `Use ${toolNameFor('account.get_onboarding')} to see what is missing, and help me with the \`nextStep\` it recommends.`,
          `If it takes a change, prepare it with the propose tools, show me what will change, and call ${CONFIRM_TOOL} only after I agree.`
        )
      )
  );
}
