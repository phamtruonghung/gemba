// src/interview.mjs — the capture mechanism.
//
// Copied deliberately from the market: the hardest part of a practitioner platform is not the
// answer, it is getting a busy practitioner to write anything at all (Tacivo's answer is an
// AI-moderated interview; Delphi's is "hand us your existing talks"). Xuong does the interview,
// but the script itself enforces the boundary the gate will check afterwards: the questions ask
// for craft, never for the plant's numbers.

export const SCRIPT = [
  {
    id: 'scope',
    ask: 'How long have you done this work, and which area are you responsible for (assembly, moulding, maintenance, stores)?',
    hint: 'The scope of the work is enough — no plant name, no customer name.'
  },
  {
    id: 'problem',
    ask: 'Which problem on the line do you have to deal with most often in a month?',
    hint: 'Describe what happens — not your plant’s figures, just how it tends to go wrong.'
  },
  {
    id: 'symptom',
    ask: 'What is the first sign of that problem, and who usually notices it first?',
    hint: 'Heard, seen, smelled, measured — what changes first?'
  },
  {
    id: 'cause',
    ask: 'What is the most common root cause, and how did you verify it?',
    hint: 'Describe the check, not the result as a number.'
  },
  {
    id: 'countermeasure',
    ask: 'What fix do you use again and again, and in what order do you do it?',
    hint: 'Step by step, specific enough for someone else to follow.'
  },
  {
    id: 'mistake',
    ask: 'Where do newcomers usually get this wrong?',
    hint: 'This is usually the most valuable part of the note.'
  },
  {
    id: 'standard',
    ask: 'If you had one line of standard to stop it happening again, what would it say?',
    hint: 'One line that anyone can follow.'
  },
  {
    id: 'transfer',
    ask: 'Does this work in another plant, another industry? Where does it stop applying?',
    hint: 'Be explicit about when NOT to use it.'
  }
];

const HEAD = {
  scope: 'Scope and experience',
  problem: 'The recurring problem',
  symptom: 'The first signs',
  cause: 'Root cause and how to verify it',
  countermeasure: 'The fix, in order',
  mistake: 'The newcomer’s mistake',
  standard: 'One line of standard',
  transfer: 'Where it applies, where it stops'
};

export function questionAt(step) {
  return SCRIPT[step] ?? null;
}

export function progress(step) {
  return { step, total: SCRIPT.length, done: step >= SCRIPT.length };
}

export function draftNoteFromInterview({ expert, topic, answers, title }) {
  const sections = SCRIPT.map((q, i) => {
    const a = String(answers[i] ?? '').trim();
    if (!a) return '';
    return `## ${HEAD[q.id]}\n${a}`;
  }).filter(Boolean);
  const body = `# ${title}\n\n${sections.join('\n\n')}\n`;
  return { title, topic, body, expert_slug: expert?.slug ?? '', origin: 'interview' };
}

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';
}
