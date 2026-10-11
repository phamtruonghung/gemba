// scratch probe: why did the interview draft fail the gate?
import { checkNote, loadRules } from '../src/gate.mjs';
import { draftNoteFromInterview } from '../src/interview.mjs';

const answers = [
  'I have done this work for twenty years, covering assembly and basic maintenance.',
  'The most repeated problem is material off specification at the last station stopping the line.',
  'The first sign is the indicator light at the last station blinking, and the final checker notices it.',
  'The root cause is usually a mis-picked material batch; verify it by comparing the packaging against the delivery note.',
  'The fix: stop the station, quarantine the suspect material, tell the team leader, write the symptom down, then restart.',
  'A newcomer replaces the sensor before checking the material, which wastes time and leaves the fault in place.',
  'The standard is to check the material before the sensor, and everyone follows that order.',
  'This works on a multi-station assembly line. It does not work when the customer supplies the material and the packaging may not be opened.'
];

const draft = draftNoteFromInterview({ expert: { slug: 'x' }, topic: 'tpm', answers, title: 'Field notes: tpm' });
const report = checkNote({ title: draft.title, body: draft.body }, loadRules());
console.log('verdict:', report.verdict, 'ok:', report.ok);
for (const f of report.findings) console.log(' ', f.severity, f.rule, JSON.stringify(f.match), '|', f.hint);
