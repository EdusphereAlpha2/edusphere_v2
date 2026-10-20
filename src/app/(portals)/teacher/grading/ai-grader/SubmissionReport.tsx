'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Edit3, FileText } from 'lucide-react';
import { SubmitButton, FormFeedback } from '@/components/ui/form';
import { setTeacherOverrideScore, setTeacherFeedback, publishResult } from './actions';
import { getEffectiveTotalScore, isScoreOverridden } from '@/lib/grading/effectiveScore';
import { computePageMarks, resolveMark } from '@/lib/grading/annotationLayout';
import type { SubmissionRow } from './types';

type Tab = 'overview' | 'annotated' | 'pdf' | 'ocr';

const TAG_STYLE: Record<string, string> = {
  strength: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  weakness: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  suggestion: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  criterion: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
};

const MARK_BORDER: Record<string, string> = {
  strength: 'border-emerald-500',
  weakness: 'border-red-500',
  suggestion: 'border-amber-500',
  criterion: 'border-violet-500'
};

const MARK_FILL: Record<string, string> = {
  strength: 'bg-emerald-500/25',
  weakness: 'bg-red-500/25',
  suggestion: 'bg-amber-500/25',
  criterion: 'bg-violet-500/25'
};

export default function SubmissionReport({ submission }: { submission: SubmissionRow }) {
  const [tab, setTab] = useState<Tab>('overview');

  const canPublish = Boolean(submission.studentId) && (submission.status === 'EVALUATED' || submission.status === 'NEEDS_REVIEW');
  const gradeScaleLabel = submission.programme === 'MYP' ? 'MYP subject grade' : 'IB course grade';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...(submission.ocrPages && submission.ocrPages.length > 0 ? [{ id: 'annotated' as Tab, label: 'Annotated paper' }] : []),
    { id: 'pdf', label: 'Original file' },
    ...(submission.ocrText ? [{ id: 'ocr' as Tab, label: 'Extracted text' }] : [])
  ];

  return (
    <div className="p-6 border-t border-slate-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex gap-2">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all ${
                tab === t.id
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'bg-white dark:bg-black border border-slate-300 dark:border-zinc-700 text-slate-600 dark:text-slate-300 hover:border-cyan-600/40'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <a
          href={submission.fileUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          <FileText size={13} aria-hidden /> Original file
        </a>
      </div>

      {tab === 'overview' && <OverviewTab submission={submission} canPublish={canPublish} gradeScaleLabel={gradeScaleLabel} />}
      {tab === 'annotated' && <AnnotatedTab submission={submission} />}
      {tab === 'pdf' && (
        <OriginalFileTab
          fileUrl={submission.fileUrl}
          fileName={submission.originalFileName ?? ''}
          studentName={submission.studentName}
        />
      )}
      {tab === 'ocr' && (
        <pre className="text-xs bg-slate-50 dark:bg-black border border-slate-200 dark:border-zinc-800 rounded-xl p-4 whitespace-pre-wrap max-h-[60vh] overflow-y-auto">
          {submission.ocrText}
        </pre>
      )}
    </div>
  );
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const WORD_EXTENSIONS = ['.docx', '.doc'];

/** Renders the originally-uploaded file appropriately for its format - an <img> for a photo, a
 *  download link for a Word doc (browsers cannot render .docx inline), and an <iframe> for
 *  everything else (PDF renders natively; plain text renders as-is). */
function OriginalFileTab({ fileUrl, fileName, studentName }: { fileUrl: string; fileName: string; studentName: string }) {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={fileUrl} alt={`${studentName} — original photo`} className="max-w-full rounded-xl border border-slate-200 dark:border-zinc-800" />
    );
  }

  if (WORD_EXTENSIONS.includes(ext)) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 p-10 text-center">
        <p className="text-sm text-slate-500 mb-3">Word documents can&apos;t be previewed inline.</p>
        <a href={fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-bold text-cyan-600 hover:text-cyan-700 dark:text-cyan-400">
          <FileText size={14} aria-hidden /> Download the original file
        </a>
      </div>
    );
  }

  return <iframe src={fileUrl} title={`${studentName} — original file`} className="w-full h-[70vh] rounded-xl border border-slate-200 dark:border-zinc-800" />;
}

function OverviewTab({
  submission,
  canPublish,
  gradeScaleLabel
}: {
  submission: SubmissionRow;
  canPublish: boolean;
  gradeScaleLabel: string;
}) {
  const router = useRouter();
  const r = submission.result;
  const effectiveScore = getEffectiveTotalScore(submission);
  const overridden = isScoreOverridden(submission);
  const pct = r.maxTotal > 0 ? Math.round((effectiveScore / r.maxTotal) * 100) : 0;

  const [overriding, setOverriding] = useState(false);
  const [overrideValue, setOverrideValue] = useState(String(effectiveScore));
  const [savingOverride, setSavingOverride] = useState(false);

  const [feedbackState, feedbackAction] = useActionState(setTeacherFeedback, undefined);
  const [publishState, publishAction] = useActionState(publishResult, undefined);

  const saveOverride = async () => {
    setSavingOverride(true);
    const n = Number(overrideValue);
    await setTeacherOverrideScore(submission.id, Number.isFinite(n) ? n : null);
    setSavingOverride(false);
    setOverriding(false);
    router.refresh();
  };

  const clearOverride = async () => {
    setSavingOverride(true);
    await setTeacherOverrideScore(submission.id, null);
    setSavingOverride(false);
    router.refresh();
  };

  const suggestedComment = r.generalFeedback.slice(0, 2).join(' ');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-5">
        <div className="flex items-start gap-6">
          <div className="shrink-0 w-24 h-24 rounded-full border-8 border-emerald-500/20 flex items-center justify-center relative">
            <span className="text-2xl font-bold text-slate-800 dark:text-slate-100">{effectiveScore}</span>
            <span className="absolute bottom-3 text-[10px] text-slate-400">/ {r.maxTotal}</span>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Detected subject: <strong>{r.detectedSubject}</strong>
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{gradeScaleLabel} percentage: <strong>{pct}%</strong></p>
            {typeof submission.ocrConfidence === 'number' && (
              <p className="text-xs text-slate-400">OCR confidence: {Math.round(submission.ocrConfidence * 100)}%</p>
            )}
            {r.error && <p className="text-xs text-amber-600 dark:text-amber-400">{r.error}</p>}
          </div>
        </div>

        {r.generalFeedback.length > 0 && (
          <ul className="space-y-1.5 text-sm text-slate-600 dark:text-slate-300 list-disc list-inside">
            {r.generalFeedback.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}

        <div className="bg-slate-50 dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-slate-500">AI-suggested score</p>
              <p className="font-mono text-sm text-slate-600 dark:text-slate-300">{r.totalScore}/{r.maxTotal}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Teacher-approved score</p>
              {overriding ? (
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    value={overrideValue}
                    onChange={e => setOverrideValue(e.target.value)}
                    className="w-16 p-1.5 border border-cyan-600 rounded text-center text-sm font-bold bg-white dark:bg-black"
                  />
                  <span className="text-xs text-slate-400">/ {r.maxTotal}</span>
                  <SubmitButtonLike onClick={saveOverride} busy={savingOverride}>Save</SubmitButtonLike>
                  <button type="button" onClick={() => setOverriding(false)} className="text-xs text-slate-500 px-2">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <span className={`font-mono text-sm font-bold ${overridden ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {effectiveScore}/{r.maxTotal}
                  </span>
                  {overridden && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400">teacher-adjusted</span>}
                  <button type="button" onClick={() => setOverriding(true)} className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 inline-flex items-center gap-1">
                    <Edit3 size={12} aria-hidden /> Override
                  </button>
                  {overridden && (
                    <button type="button" onClick={clearOverride} disabled={savingOverride} className="text-xs text-red-500 hover:text-red-600">
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {r.scoreRationale && (
            <p className="text-xs text-slate-500 dark:text-slate-400 border-t border-dashed border-slate-200 dark:border-zinc-800 pt-3">
              <span className="font-bold text-slate-600 dark:text-slate-300">Why this score: </span>
              {r.scoreRationale}
            </p>
          )}
        </div>

        <form action={feedbackAction} className="space-y-2">
          <input type="hidden" name="submissionId" value={submission.id} />
          <label className="block text-xs font-medium text-slate-500" htmlFor="tf">Teacher feedback</label>
          <textarea
            id="tf"
            name="teacherFeedback"
            defaultValue={submission.teacherFeedback ?? ''}
            rows={3}
            placeholder="Add your own notes for this student…"
            className="w-full p-2.5 border border-slate-300 dark:border-zinc-700 rounded-xl text-sm bg-white dark:bg-black text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-cyan-600/40 focus:border-cyan-600"
          />
          <div className="flex items-center gap-3">
            <SubmitButton size="sm" pendingText="Saving…" className="!rounded-xl">Save feedback</SubmitButton>
            <FormFeedback state={feedbackState} />
          </div>
        </form>
      </div>

      <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 shadow-sm h-fit">
        {submission.status === 'PUBLISHED' ? (
          <div className="text-center py-4">
            <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Published</span>
            <p className="text-xs text-slate-400 mt-3">This result is live in the family-facing gradebook.</p>
          </div>
        ) : canPublish ? (
          <form action={publishAction} className="space-y-3">
            <input type="hidden" name="submissionId" value={submission.id} />
            <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100">Publish to family gradebook</h4>
            <p className="text-xs text-slate-400">
              Confirm the final IB grade (1–7) based on the AI score above — this app never auto-computes a grade
              without real boundaries, so it&apos;s yours to enter, same as the manual gradebook.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1" htmlFor="pg-grade">Final IB grade</label>
              <input
                id="pg-grade"
                name="grade"
                type="number"
                min={1}
                max={7}
                step={1}
                required
                className="w-full p-2 border border-slate-300 dark:border-zinc-700 rounded-xl text-center text-sm font-bold bg-white dark:bg-black focus:outline-none focus:ring-2 focus:ring-cyan-600/40 focus:border-cyan-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1" htmlFor="pg-type">Type</label>
              <select id="pg-type" name="type" defaultValue="SUMMATIVE" className="w-full p-2 border border-slate-300 dark:border-zinc-700 rounded-xl text-sm bg-white dark:bg-black focus:outline-none focus:ring-2 focus:ring-cyan-600/40 focus:border-cyan-600">
                <option value="FORMATIVE">Formative</option>
                <option value="SUMMATIVE">Summative</option>
                <option value="MOCK">Mock</option>
                <option value="IA_DRAFT">IA draft</option>
                <option value="ORAL">Oral</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1" htmlFor="pg-comment">Comment sent to family</label>
              <textarea
                id="pg-comment"
                name="comment"
                defaultValue={suggestedComment}
                rows={2}
                className="w-full p-2 border border-slate-300 dark:border-zinc-700 rounded-xl text-sm bg-white dark:bg-black focus:outline-none focus:ring-2 focus:ring-cyan-600/40 focus:border-cyan-600"
              />
            </div>
            <SubmitButton className="w-full !bg-cyan-600 hover:!bg-cyan-700 !text-white !rounded-xl" pendingText="Publishing…">
              <Send size={14} aria-hidden /> Publish
            </SubmitButton>
            <FormFeedback state={publishState} />
          </form>
        ) : (
          <p className="text-xs text-slate-400">
            {submission.studentId
              ? 'This submission needs to finish grading before it can be published.'
              : 'Assign a student to this sheet (in the queue) before it can be published.'}
          </p>
        )}
      </div>
    </div>
  );
}

function SubmitButtonLike({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="px-2.5 py-1 text-xs font-bold rounded bg-cyan-600 hover:bg-cyan-700 text-white disabled:opacity-60"
    >
      {busy ? '…' : children}
    </button>
  );
}

/** PaddleOCR-VL-1.6 (see ocr.ts) reports OCR'd text as markdown with no per-line pixel
 *  position, so annotations can no longer be drawn as highlight boxes over a rendered page
 *  image (the older PP-OCRv6 model this used to run on provided that). Instead, each page's
 *  OCR'd lines are rendered as text, with the specific line(s) an annotation refers to
 *  highlighted inline - clicking a highlighted line shows that annotation's comment. */
function AnnotatedTab({ submission }: { submission: SubmissionRow }) {
  const [active, setActive] = useState<string | null>(null);
  const pages = useMemo(() => submission.ocrPages ?? [], [submission.ocrPages]);
  const perPageMarks = useMemo(() => computePageMarks(pages, submission.result.annotations), [pages, submission.result.annotations]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(TAG_STYLE).map(([type, cls]) => (
          <span key={type} className={`px-2.5 py-1 rounded-full font-bold capitalize ${cls}`}>{type}</span>
        ))}
      </div>
      {pages.map((page, pageIndex) => {
        const marks = perPageMarks[pageIndex] ?? [];
        const markByLine = new Map(marks.map(m => [m.lineIndex, m]));
        return (
          <div key={pageIndex} className="border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <p className="px-4 pt-3 text-xs font-bold text-slate-400">Page {pageIndex + 1}</p>
            <div className="p-4 space-y-1 font-mono text-xs whitespace-pre-wrap">
              {page.lines.map((line, lineIndex) => {
                const m = markByLine.get(lineIndex);
                if (!m) return <p key={lineIndex} className="text-slate-600 dark:text-slate-300">{line.text}</p>;
                const mark = resolveMark(m.annotation, submission.result.questions);
                return (
                  <div key={lineIndex} className="relative">
                    <button
                      type="button"
                      onClick={() => setActive(active === m.key ? null : m.key)}
                      className={`text-left w-full rounded px-1 -mx-1 border-l-4 ${MARK_FILL[m.annotation.type]} ${MARK_BORDER[m.annotation.type]}`}
                    >
                      {line.text}
                    </button>
                    {active === m.key && (
                      <span className="block mt-1 mb-2 w-full max-w-md text-left normal-case whitespace-normal text-xs rounded-lg p-2.5 shadow-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-700 dark:text-slate-200">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold mb-1 ${TAG_STYLE[m.annotation.type]}`}>
                          {m.annotation.type}{mark ? ` · ${mark.score}/${mark.maxScore}` : ''}
                        </span>
                        <span className="block">{m.annotation.comment}</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

