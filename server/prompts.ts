// Agent prompts. Written in English (compact, consistent across UI languages); every user-facing
// field is produced in the office language via LANG_RULE.
import type { Employee, Lang, OfficeType, Task, TaskReport, TemplateText } from '../shared/types.ts';

export interface OfficeTemplate {
  id: OfficeType;
  icon: string;
  locked?: boolean;
  maxEmployees: number;
  workflow: string;
  guidance: string;
  roles: { key: string; title: string; duty: string }[];
  i18n: Record<Lang, TemplateText>;
}

export const LANG_NAME: Record<Lang, string> = { en: 'English', vi: 'Vietnamese (tiếng Việt)', zh: 'Simplified Chinese (简体中文)' };

const langRule = (lang: Lang) =>
  `LANGUAGE: write every user-facing text (reply, summary, BRIEF, role titles, reasons, task titles/descriptions, reports, notes) in ${LANG_NAME[lang]}. Code, identifiers and file names stay as they are.`;

const CAPS = 'git_commit | git_push | install_deps | deploy | network | full_access';

// ---------- system cards (sent once per session, then cached by the provider) ----------

export function coordinatorCard(t: OfficeTemplate, lang: Lang) {
  return `You are the LEAD (coordinating agent) of the "${t.i18n.en.name}" in the NexCanvas app. The user is your boss.
Workflow: ${t.workflow}.
Office guidance: ${t.guidance}
Your job: understand the project, propose staff, split work into tasks, review results, report to the boss.
Rules:
- ${langRule(lang)}
- Be brief and concrete with the boss.
- You do NOT edit project files yourself; you read to understand and delegate to employees.
- Save tokens: read only the files you need, never the whole project; write tasks clear enough that employees never need to ask back.
- A good task = clear file scope, measurable acceptance criteria, as independent as possible so it can run in parallel.
- Sensitive operations (git push, deploy, installing dependencies, network) must be declared in "needs" so the boss can grant them once.
- The office-wide brief lives in .office/BRIEF.md.`;
}

/** `office` = absolute path of the project's .office folder (workers may run in a separate git worktree). */
export function employeeCard(e: Employee, duty: string, office: string, lang: Lang) {
  return `You are ${e.name}, ${e.title}, in an agent office run by a lead agent.
Expertise: ${duty}
${e.skills.length ? `Assigned skills (use when relevant): ${e.skills.join(', ')}.` : ''}
Working rules:
- ${langRule(lang)}
- On your first task, read ${office}/BRIEF.md (project overview) first.
- The current directory is your workspace (it may be your own git branch); only change files there.
- Stay within the task scope; if you must touch files outside it, say so in the report.
- After each task, append ≤10 lines to ${office}/agents/${e.id}.md: what you did, key decisions, unfinished work. This is your handover notebook.
- Do not commit/push/deploy (the office commits and merges approved work) unless the task explicitly asks.
- Finish every task with the JSON report in the requested schema.`;
}

// ---------- schemas ----------

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type as string, 'null'] });

/**
 * ONE schema for every lead turn. The schema becomes a tool definition, and tool definitions sit at the
 * very start of the prompt-cache prefix: switching schemas between turns would invalidate the whole
 * cached conversation each time. Fields that don't apply to a turn are null.
 */
export const COORDINATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'summary', 'brief_markdown', 'team', 'risks', 'tasks', 'verdict', 'feedback'],
  properties: {
    reply: { type: 'string', description: 'Short answer to the boss.' },
    summary: nullable({ type: 'string', description: '[analysis] Project summary, 3-6 sentences.' }),
    brief_markdown: nullable({ type: 'string', description: '[analysis] Content of .office/BRIEF.md.' }),
    team: nullable({
      type: 'array',
      description: '[analysis] Proposed staff.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['roleKey', 'title', 'why', 'modelTier', 'skills'],
        properties: {
          roleKey: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
          modelTier: { type: 'string', enum: ['high', 'standard', 'light'] },
          skills: { type: 'array', items: { type: 'string' } },
        },
      },
    }),
    risks: nullable({ type: 'array', items: { type: 'string' } }),
    tasks: nullable({
      type: 'array',
      description: '[planning] Tasks.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'description', 'acceptance', 'assignee', 'dependsOn', 'needs'],
        properties: {
          key: { type: 'string', description: 'Temporary key such as T1, T2' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'string' },
          assignee: { type: 'string', description: 'employee id' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string', enum: CAPS.split(' | ') } },
        },
      },
    }),
    verdict: { type: ['string', 'null'], enum: ['approve', 'revise', null], description: '[review]' },
    feedback: nullable({ type: 'string', description: '[review] Comments / requested changes.' }),
  },
};

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'files_changed', 'tests', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    blockers: { type: 'string' },
  },
};

// ---------- turn prompts ----------

export function analyzePrompt(opts: { template: OfficeTemplate; contextFiles: string[]; skillCatalog: string; feedback?: string }) {
  const { template, contextFiles, skillCatalog, feedback } = opts;
  if (feedback) {
    return `The boss commented on the staffing proposal: """${feedback}"""
Adjust the proposal. Return JSON: fill reply, summary, brief_markdown (unchanged if still valid), team, risks; tasks/verdict/feedback = null.`;
  }
  return `The boss just assigned you the project in the current directory. Do NOT hire anyone yet — first understand the project.
${contextFiles.length ? `Context documents (read first): ${contextFiles.map((f) => `.office/context/${f}`).join(', ')}` : 'No context documents were provided.'}

Steps:
1. Survey the project just enough to understand it (README, config files, folder structure, a few core files, existing assets). Do not read everything.
2. Write brief_markdown for the whole office (≤ 60 lines): goal, stack/tools, structure, how to run/test/render, conventions, current state, unfinished work from the context documents.
3. Propose the MINIMUM number of employees needed (1-${template.maxEmployees}), each with a reason. Small jobs get 1-2 people.
   Available roles: ${template.roles.map((r) => `${r.key} (${r.title})`).join(', ')}. Create another role only if truly needed.
   modelTier: "high" only for hard/architectural work; otherwise "standard"; trivial work "light".
4. For each role pick at most 4 genuinely useful skills from this list ([] if none):
${skillCatalog || '(no skills found)'}
5. Put anything the office cannot do for this project, and other risks, in "risks".

Return JSON: fill reply (1 sentence), summary, brief_markdown, team, risks; tasks/verdict/feedback = null.`;
}

export function planPrompt(message: string, employees: Employee[], tasks: Task[]) {
  const staff = employees.map((e) => `- ${e.id}: ${e.name} — ${e.title}`).join('\n');
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed');
  return `Message from the boss: """${message}"""

Current staff:
${staff || '(no employees yet — if work is needed, tell the boss to hire first)'}
${open.length ? `Open tasks: ${open.map((t) => `${t.id} ${t.title} [${t.status}]`).join('; ')}` : ''}

If this is a work request (and within the office limits): split it into tasks (few but sufficient, 15-60 minutes of work each), set assignee to an employee id, declare dependsOn (by key) and needs.
If it is only a question/discussion, or out of scope: answer in "reply" and set tasks = [].
Return JSON: fill reply and tasks; other fields = null.`;
}

/** Resume / bootstrap prefixes are added at run time (see office.runJob) so they match the live session. */
export function executePrompt(task: Task) {
  const parts = [`${task.id}: ${task.title}\nDescription: ${task.description}\nAcceptance criteria: ${task.acceptance}`];
  if (task.reviewNote) parts.push(`The lead asked for changes: ${task.reviewNote}`);
  parts.push('When done, return the JSON report in the requested schema.');
  return parts.join('\n\n');
}

export const RESUME_NOTE = '⚠️ You were interrupted (usage limit or error). Check the current state of the files and CONTINUE; do not redo finished work.';
export const bootstrapNote = (office: string, notes?: string) =>
  `Before starting: read ${office}/BRIEF.md${notes ? ` and your handover notebook ${notes}` : ''}.`;
export const conflictNote = (files: string[]) =>
  `⚠️ Teammates' work was just merged into your branch and there are CONFLICTS in: ${files.join(', ')}. Resolve them first (keep both sides' intent), then do the task.`;

export function reviewPrompt(task: Task, report: TaskReport, diffStat: string, patch: string, worktree?: string) {
  const where = worktree
    ? `The work is in the employee's own workspace: ${worktree.split('\\').join('/')} (read files there if needed).`
    : 'The work is directly in the project folder.';
  return `Review ${task.id}: ${task.title}
Acceptance: ${task.acceptance}
Employee report: ${JSON.stringify(report)}
${where}
git diff --stat:
${diffStat || '(no changes)'}
${patch ? `\nDiff:\n\`\`\`diff\n${patch}\n\`\`\`` : ''}

${patch ? 'The diff is above — open other files only if really needed.' : 'Check quickly with git diff on the relevant files (not the whole project).'} If it passes, verdict "approve"; otherwise "revise" with specific, actionable feedback.
Return JSON: fill reply (1 sentence), verdict, feedback; other fields = null.`;
}

export function summaryPrompt(goal: string, tasks: Task[]) {
  return `All tasks for the request "${goal}" have finished:
${tasks
  .map((t) => {
    const merge = t.merge?.status === 'merged' ? ` [MERGED into the main branch, commit ${t.merge.commit}]` : t.merge?.status === 'failed' ? ` [NOT MERGED: ${t.merge.note ?? ''}]` : '';
    return `- ${t.id} ${t.title}: ${t.status}${merge}${t.report ? ` — ${t.report.summary.slice(0, 200)}` : ''}`;
  })
  .join('\n')}
(The office commits and merges approved work itself; never tell the boss to merge tasks that are already merged.)
Before writing: if the project has a test command, run it ONCE in the project folder (merged code) to confirm everything is still green.

Write a short report for the boss (≤ 12 lines) in "reply": what was done, how to check it, remaining work/risks, suggested next step. Other fields = null.`;
}
