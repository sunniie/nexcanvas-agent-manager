import type { Employee, Task, TaskReport } from '../shared/types.ts';

export interface OfficeTemplate {
  id: string;
  name: string;
  description: string;
  maxEmployees: number;
  workflow: string;
  roles: { key: string; title: string; duty: string }[];
}

const CAPS = 'git_commit | git_push | install_deps | deploy | network | full_access';

// ---------- system cards (sent once per session, then cached by the provider) ----------

export function coordinatorCard(t: OfficeTemplate) {
  return `Bạn là TRƯỞNG PHÒNG (agent điều phối) của "${t.name}" trong ứng dụng NexCanvas.
Quy trình: ${t.workflow}.
Nhiệm vụ: hiểu dự án, đề xuất nhân sự, chia việc, review kết quả, báo cáo cho người dùng (sếp).
Nguyên tắc:
- Trả lời người dùng bằng tiếng Việt, ngắn gọn, đi thẳng vào việc.
- Bạn KHÔNG tự sửa code; bạn đọc repo để hiểu và giao việc cho nhân viên.
- Tiết kiệm token: chỉ đọc file thật sự cần, không đọc cả repo; giao task rõ ràng để nhân viên khỏi phải hỏi lại.
- Task tốt = phạm vi file rõ, tiêu chí nghiệm thu đo được, độc lập nhất có thể để chạy song song.
- Thao tác nhạy cảm (push git, deploy, cài thư viện...) phải khai báo trong "needs" để xin phép sếp một lần.
- Tài liệu chung của cả văn phòng nằm ở .office/BRIEF.md.`;
}

/** `office` = absolute path of the project's .office folder (workers may run in a separate git worktree). */
export function employeeCard(e: Employee, duty: string, office: string) {
  return `Bạn là ${e.name}, ${e.title} trong một văn phòng agent do Trưởng phòng điều phối.
Chuyên môn: ${duty}
${e.skills.length ? `Skill được giao (dùng khi phù hợp): ${e.skills.join(', ')}.` : ''}
Quy tắc làm việc:
- Lần đầu làm việc: đọc ${office}/BRIEF.md (tổng quan dự án) trước.
- Thư mục hiện tại là chỗ làm việc của bạn (có thể là nhánh git riêng); chỉ sửa code trong đó.
- Chỉ làm đúng phạm vi task; không sửa file ngoài phạm vi trừ khi bắt buộc và phải nêu trong báo cáo.
- Sau mỗi task, ghi ngắn (≤10 dòng) vào ${office}/agents/${e.id}.md: đã làm gì, quyết định quan trọng, việc dở. Đây là sổ tay giao ca của bạn.
- Không commit/push/deploy (văn phòng tự commit & gộp code khi được duyệt) trừ khi task yêu cầu rõ.
- Kết thúc mỗi task bằng báo cáo JSON đúng schema được yêu cầu. Viết tiếng Việt, ngắn gọn.`;
}

// ---------- schemas ----------

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type as string, 'null'] });

/**
 * ONE schema for every coordinator turn. The schema becomes a tool definition, and tool definitions
 * sit at the very start of the prompt-cache prefix: switching schemas between turns would invalidate
 * the whole cached conversation each time. Fields that don't apply to a turn are null.
 */
export const COORDINATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'summary', 'brief_markdown', 'team', 'risks', 'tasks', 'verdict', 'feedback'],
  properties: {
    reply: { type: 'string', description: 'Câu trả lời ngắn cho sếp.' },
    summary: nullable({ type: 'string', description: '[phân tích] Tóm tắt dự án 3-6 câu.' }),
    brief_markdown: nullable({ type: 'string', description: '[phân tích] Nội dung .office/BRIEF.md.' }),
    team: nullable({
      type: 'array',
      description: '[phân tích] Nhân sự đề xuất.',
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
      description: '[giao việc] Danh sách task.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'description', 'acceptance', 'assignee', 'dependsOn', 'needs'],
        properties: {
          key: { type: 'string', description: 'Mã tạm như T1, T2' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'string' },
          assignee: { type: 'string', description: 'id nhân viên' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string', enum: CAPS.split(' | ') } },
        },
      },
    }),
    verdict: { type: ['string', 'null'], enum: ['approve', 'revise', null], description: '[review]' },
    feedback: nullable({ type: 'string', description: '[review] Nhận xét / yêu cầu sửa.' }),
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

export function analyzePrompt(opts: {
  template: OfficeTemplate;
  contextFiles: string[];
  skillCatalog: string;
  feedback?: string;
}) {
  const { template, contextFiles, skillCatalog, feedback } = opts;
  if (feedback) {
    return `Sếp góp ý về đề xuất nhân sự: "${feedback}"
Hãy điều chỉnh đề xuất. Trả về JSON: điền reply, summary, brief_markdown (giữ nguyên nếu không đổi), team, risks; tasks/verdict/feedback = null.`;
  }
  return `Sếp vừa giao cho bạn dự án ở thư mục hiện tại.
${contextFiles.length ? `Tài liệu ngữ cảnh (đọc trước): ${contextFiles.map((f) => `.office/context/${f}`).join(', ')}` : 'Không có tài liệu ngữ cảnh đi kèm.'}

Việc cần làm:
1. Khảo sát repo ở mức đủ hiểu (README, file cấu hình, cấu trúc thư mục, vài file lõi). Đừng đọc tràn lan.
2. Viết brief_markdown cho cả văn phòng (≤ 60 dòng): mục tiêu, tech stack, cấu trúc, cách chạy/test, quy ước, trạng thái hiện tại, việc dở dang từ tài liệu ngữ cảnh.
3. Đề xuất số nhân viên TỐI THIỂU cần thiết (1-${template.maxEmployees}), mỗi người phải có lý do. Dự án nhỏ thì 1-2 người.
   Vai trò có sẵn: ${template.roles.map((r) => `${r.key} (${r.title})`).join(', ')}. Có thể tạo vai trò khác nếu thật cần.
   modelTier: "high" chỉ cho việc khó/kiến trúc; còn lại "standard"; việc lặt vặt "light".
4. Với mỗi vai trò, chọn tối đa 4 skill THẬT SỰ hữu ích từ danh sách dưới (để [] nếu không cần):
${skillCatalog || '(không tìm thấy skill nào)'}

Trả về JSON: điền reply (1 câu), summary, brief_markdown, team, risks; tasks/verdict/feedback = null.`;
}

export function planPrompt(message: string, employees: Employee[], tasks: Task[]) {
  const staff = employees.map((e) => `- ${e.id}: ${e.name} — ${e.title}`).join('\n');
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed');
  return `Tin nhắn của sếp: """${message}"""

Nhân viên hiện có:
${staff || '(chưa có nhân viên — nếu cần làm việc, hãy nói sếp tuyển trước)'}
${open.length ? `Task đang mở: ${open.map((t) => `${t.id} ${t.title} [${t.status}]`).join('; ')}` : ''}

Nếu là yêu cầu công việc: chia thành các task (ít nhưng đủ, mỗi task 15-60 phút làm việc của một người), gán assignee bằng id nhân viên, khai báo dependsOn (theo key) và needs.
Nếu chỉ là câu hỏi/trao đổi: trả lời trong "reply" và để tasks = [].
Trả về JSON: điền reply và tasks; các trường khác = null.`;
}

/** Resume / bootstrap prefixes are added at run time (see office.runJob) so they match the live session. */
export function executePrompt(task: Task) {
  const parts: string[] = [];
  parts.push(`${task.id}: ${task.title}
Mô tả: ${task.description}
Tiêu chí nghiệm thu: ${task.acceptance}`);
  if (task.reviewNote) parts.push(`Trưởng phòng yêu cầu sửa lại: ${task.reviewNote}`);
  parts.push('Làm xong thì trả về báo cáo JSON đúng schema.');
  return parts.join('\n\n');
}

export function reviewPrompt(task: Task, report: TaskReport, diffStat: string, patch: string, worktree?: string) {
  const where = worktree
    ? `Code nằm trong thư mục làm việc riêng của nhân viên: ${worktree.split('\\').join('/')} (đọc file ở đó nếu cần).`
    : 'Code nằm ngay trong thư mục dự án.';
  return `Review ${task.id}: ${task.title}
Tiêu chí: ${task.acceptance}
Báo cáo của nhân viên: ${JSON.stringify(report)}
${where}
git diff --stat:
${diffStat || '(không có thay đổi)'}
${patch ? `\nDiff:\n\`\`\`diff\n${patch}\n\`\`\`` : ''}

${patch ? 'Diff đã có ở trên — chỉ đọc thêm file khi thật cần.' : 'Kiểm tra nhanh bằng git diff các file liên quan (không đọc cả repo).'} Đạt thì verdict "approve"; chưa đạt thì "revise" kèm feedback cụ thể, làm được ngay.
Trả về JSON: điền reply (1 câu), verdict, feedback; các trường khác = null.`;
}

export function summaryPrompt(goal: string, tasks: Task[]) {
  return `Mọi task cho yêu cầu "${goal}" đã kết thúc:
${tasks
  .map((t) => {
    const merge = t.merge?.status === 'merged' ? ` [ĐÃ GỘP vào nhánh chính, commit ${t.merge.commit}]` : t.merge?.status === 'failed' ? ` [CHƯA GỘP: ${t.merge.note ?? ''}]` : '';
    return `- ${t.id} ${t.title}: ${t.status}${merge}${t.report ? ` — ${t.report.summary.slice(0, 200)}` : ''}`;
  })
  .join('\n')}
(Văn phòng tự commit & gộp code đã duyệt; đừng khuyên sếp gộp lại những task đã gộp.)
Trước khi viết báo cáo: nếu dự án có lệnh test, chạy nó MỘT lần ngay trong thư mục dự án (code đã gộp) để xác nhận mọi thứ vẫn xanh sau khi gộp.

Viết báo cáo ngắn cho sếp (≤ 12 dòng) vào "reply": đã làm được gì, cách kiểm tra, việc còn lại/rủi ro, đề xuất bước tiếp theo. Các trường khác = null.`;
}
