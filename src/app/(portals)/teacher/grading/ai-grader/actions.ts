'use server';

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { guard, TEACHER_ROLES } from '@/lib/authz';
import type { ActionState } from '@/components/ui/form';
import { extractAnswerText, isAcceptedAnswerSheet, isLegacyDoc, guessMimeType } from '@/lib/grading/extractText';
import { gradeAnswerSheet, buildMarkedOcrText } from '@/lib/grading/grade';
import { readAnswerSheet, uploadAnswerSheet } from '@/lib/grading/storage';
import { upsertMarkingScheme, findMarkingScheme } from '@/lib/grading/markingScheme';
import { combineImagesToPdf } from '@/lib/grading/combineImages';
import type { CourseworkType, IBProgramme } from '@/lib/grading/types';

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
function isImageFile(f: File): boolean {
  return IMAGE_MIME_TYPES.has(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
}

export async function ctx() {
  const auth = await guard(TEACHER_ROLES);
  if (!auth.ok) return null;
  const teacher = await prisma.teacher.findUnique({
    where: { userId: auth.user.id },
    select: { id: true, subjects: true, classes: { select: { id: true, name: true } } },
  });
  if (!teacher) return null;
  return { auth, teacher };
}

const COURSEWORK_TYPES: CourseworkType[] = ['internal-assessment', 'extended-essay', 'tok', 'external-assessment', 'exam'];
const PROGRAMMES: IBProgramme[] = ['DP', 'MYP'];

/**
 * Upload one scanned answer sheet and grade it: store the PDF in Blob, run
 * PaddleOCR, grade with the Groq -> OpenAI failover pool, and write the full
 * result to AIGradingSubmission. Nothing touches AssessmentResult yet - that
 * only happens on publish (below), once a teacher has reviewed the AI's work.
 */
export async function uploadAndGrade(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing. Ask an administrator to check your profile.' };

  const classroomId = String(formData.get('classroomId') ?? '');
  const studentId = String(formData.get('studentId') ?? '');
  const subjectName = String(formData.get('subjectName') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const term = String(formData.get('term') ?? '').trim();
  const level = String(formData.get('level') ?? '');
  const rawProgramme = String(formData.get('programme') ?? '');
  const rawCourseworkType = String(formData.get('courseworkType') ?? '');
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const markingSchemeFile = formData.get('markingScheme');

  if (!c.teacher.classes.some(k => k.id === classroomId)) return { error: 'That is not one of your classes.' };
  if (!title) return { error: 'Name the assessment — it is how the result is identified later.' };
  if (!term) return { error: 'Choose a term.' };
  if (!subjectName) return { error: 'Choose a subject.' };
  if (files.length === 0) return { error: 'Choose an answer sheet to upload.' };
  // Multiple files for one student means "one photo per page of the same sheet" - anything
  // else (a PDF plus a photo, two PDFs, etc.) has no sensible way to combine into one
  // submission, so only a single non-image file is accepted; a single image is fine too
  // (handled the same as one page below) and doesn't need combining.
  if (files.length > 1 && !files.every(isImageFile)) {
    return {
      error: 'When uploading multiple files for one student, every file must be a photo (JPG/PNG/WEBP) — one per page. For a PDF, Word document, or text file, upload just that single file.',
    };
  }
  for (const f of files) {
    if (isLegacyDoc(f.name, f.type)) {
      return { error: 'Old-style .doc files are not supported — re-save as .docx (Word: File > Save As > Word Document) and re-upload.' };
    }
    if (!isAcceptedAnswerSheet(f.name, f.type)) {
      return { error: `"${f.name}" is an unsupported file type — upload a PDF, Word document (.docx), plain text (.txt), or a photo (JPG/PNG/WEBP).` };
    }
  }
  if (markingSchemeFile instanceof File && markingSchemeFile.size > 0) {
    if (isLegacyDoc(markingSchemeFile.name, markingSchemeFile.type)) {
      return { error: 'The marking scheme is an old-style .doc file — re-save it as .docx and re-upload.' };
    }
    if (!isAcceptedAnswerSheet(markingSchemeFile.name, markingSchemeFile.type)) {
      return { error: 'The marking scheme is an unsupported file type — upload a PDF, Word document (.docx), plain text (.txt), or a photo (JPG/PNG/WEBP).' };
    }
  }

  const student = await prisma.student.findFirst({
    where: { id: studentId, classroomId, isActive: true },
    select: { id: true },
  });
  if (!student) return { error: 'Choose a student from this class.' };

  const programme: IBProgramme = PROGRAMMES.includes(rawProgramme as IBProgramme) ? (rawProgramme as IBProgramme) : 'DP';
  const courseworkType: CourseworkType = COURSEWORK_TYPES.includes(rawCourseworkType as CourseworkType)
    ? (rawCourseworkType as CourseworkType)
    : 'exam';

  // A marking scheme uploaded alongside this sheet is attached to the whole assessment (every
  // sheet for this classroom/subject/title/term), not just this one submission - see
  // markingScheme.ts. If none is uploaded this time, fall back to one already on file for this
  // assessment from an earlier upload.
  let markingSchemeText: string | null = null;
  if (markingSchemeFile instanceof File && markingSchemeFile.size > 0) {
    try {
      const msBuffer = Buffer.from(await markingSchemeFile.arrayBuffer());
      const msMimeType = markingSchemeFile.type || guessMimeType(markingSchemeFile.name);
      const msOcr = await extractAnswerText(msBuffer, markingSchemeFile.name, msMimeType);
      const msFileUrl = await uploadAnswerSheet(msBuffer, markingSchemeFile.name, msMimeType);
      await upsertMarkingScheme({ classroomId, teacherId: c.teacher.id, subjectName, title, term, programme, courseworkType, fileUrl: msFileUrl, rawText: msOcr.text });
      markingSchemeText = msOcr.text;
    } catch (err) {
      return { error: `Could not process the marking scheme: ${(err as Error).message}` };
    }
  } else {
    markingSchemeText = await findMarkingScheme({ classroomId, subjectName, title, term });
  }

  let buffer: Buffer;
  let combinedFileName: string;
  let combinedMimeType: string;
  if (files.length === 1) {
    buffer = Buffer.from(await files[0].arrayBuffer());
    combinedFileName = files[0].name;
    combinedMimeType = files[0].type || guessMimeType(files[0].name);
  } else {
    // Multiple page photos for this one student - merge into a single multi-page PDF so
    // everything downstream (OCR, the grading prompt's page numbering, Retry, the Annotated
    // paper view) treats this exactly like any other multi-page scanned PDF, no special-casing
    // needed anywhere else in the pipeline.
    try {
      const imageBuffers = await Promise.all(files.map(f => f.arrayBuffer().then(a => Buffer.from(a))));
      buffer = await combineImagesToPdf(imageBuffers);
    } catch (err) {
      return { error: `Could not combine the uploaded photos into one sheet: ${(err as Error).message}` };
    }
    combinedFileName = `${files.length}-page-answer-sheet.pdf`;
    combinedMimeType = 'application/pdf';
  }

  let fileUrl: string;
  try {
    fileUrl = await uploadAnswerSheet(buffer, combinedFileName, combinedMimeType);
  } catch (err) {
    return { error: `Could not store the file: ${(err as Error).message}` };
  }

  const submission = await prisma.aIGradingSubmission.create({
    data: {
      studentId: student.id,
      originalFileName: combinedFileName,
      classroomId,
      teacherId: c.teacher.id,
      subjectName,
      title,
      term,
      programme,
      courseworkType,
      fileUrl,
      result: { questions: [], generalFeedback: [], totalScore: 0, maxTotal: 0, detectedSubject: subjectName, annotations: [], scoreRationale: '' },
      totalScore: 0,
      maxTotal: 0,
      status: 'OCR_PROCESSING',
    },
  });

  await runGrading(submission.id, buffer, combinedFileName, combinedMimeType, { subjectName, level, courseworkType, programme, markingSchemeText });

  revalidatePath('/teacher/grading/ai-grader');
  return {
    success:
      (files.length === 1 ? `${files[0].name} uploaded` : `${files.length} pages combined and uploaded`) +
      ' — grading in progress.' +
      (markingSchemeText ? ' Grading against the uploaded marking scheme.' : ''),
  };
}

/** Shared by uploadAndGrade, retryGrading, and bulkUploadAndGrade (bulkActions.ts). Never
 *  throws — every failure is written to the submission row itself (status FAILED +
 *  errorMessage) so it shows up in the queue rather than vanishing into a server log.
 *  Dispatches by format (PDF/image via OCR, .docx via mammoth, .txt read directly) so the
 *  rest of the pipeline never needs to know which one it was handed - see extractText.ts.
 *
 *  onOcrComplete, when given, runs right after OCR text is available and before grading
 *  starts - bulkUploadAndGrade uses it to attempt matching a still-unassigned sheet to a
 *  student from whatever name/roll-number is written on the sheet itself, now that the text
 *  to search is actually available, without OCR'ing the file a second time to get it. */
export async function runGrading(
  submissionId: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  params: { subjectName: string; level: string; courseworkType: CourseworkType; programme: IBProgramme; markingSchemeText?: string | null },
  onOcrComplete?: (ocrText: string) => Promise<void>
): Promise<void> {
  try {
    const ocr = await extractAnswerText(fileBuffer, fileName, mimeType);
    await prisma.aIGradingSubmission.update({
      where: { id: submissionId },
      data: {
        status: 'EVALUATING',
        ocrText: ocr.text,
        ocrPages: ocr.pages as unknown as Prisma.InputJsonValue,
        ocrConfidence: ocr.ocrConfidence
      },
    });

    if (onOcrComplete) await onOcrComplete(ocr.text);

    const markedText = buildMarkedOcrText(ocr.pages);
    const result = await gradeAnswerSheet({
      ocrText: markedText,
      subject: params.subjectName,
      level: params.level,
      courseworkType: params.courseworkType,
      programme: params.programme,
      markingSchemeText: params.markingSchemeText,
    });

    const lowConfidence = typeof ocr.ocrConfidence === 'number' && ocr.ocrConfidence < 0.75;
    const status = result.error || lowConfidence ? 'NEEDS_REVIEW' : 'EVALUATED';

    await prisma.aIGradingSubmission.update({
      where: { id: submissionId },
      data: { status, result: result as object, totalScore: result.totalScore, maxTotal: result.maxTotal },
    });
  } catch (err) {
    await prisma.aIGradingSubmission.update({
      where: { id: submissionId },
      data: { status: 'FAILED', errorMessage: (err as Error).message },
    });
  }
}

/** Re-runs OCR + grading on a submission that failed, reusing the already-uploaded file -
 *  no re-upload needed. */
export async function retryGrading(submissionId: string): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };

  const submission = await prisma.aIGradingSubmission.findUnique({ where: { id: submissionId } });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) {
    return { error: 'That submission is not in one of your classes.' };
  }

  let storedFile: Awaited<ReturnType<typeof readAnswerSheet>>;
  try {
    storedFile = await readAnswerSheet(submission.fileUrl);
  } catch (err) {
    return { error: `Could not re-fetch the stored file: ${(err as Error).message}` };
  }
  const buffer = Buffer.from(await new Response(storedFile.stream).arrayBuffer());

  const fileName = submission.originalFileName || storedFile.fileName;
  const mimeType = storedFile.contentType || guessMimeType(fileName);

  const markingSchemeText = await findMarkingScheme({
    classroomId: submission.classroomId,
    subjectName: submission.subjectName,
    title: submission.title,
    term: submission.term,
  });

  await prisma.aIGradingSubmission.update({ where: { id: submissionId }, data: { status: 'OCR_PROCESSING', errorMessage: null } });
  await runGrading(submissionId, buffer, fileName, mimeType, {
    subjectName: submission.subjectName,
    level: '',
    courseworkType: submission.courseworkType as CourseworkType,
    programme: submission.programme as IBProgramme,
    markingSchemeText,
  });

  revalidatePath('/teacher/grading/ai-grader');
  return { success: 'Re-grading complete.' };
}

/** Removes a submission from the queue entirely. Safe to do at any status - the Prisma
 *  relation to AssessmentResult is SetNull, so a published grade already sitting in the
 *  gradebook is untouched; only the AI grader's own row (file reference, OCR text, etc.)
 *  goes away. */
export async function deleteSubmission(submissionId: string): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };

  const submission = await prisma.aIGradingSubmission.findUnique({ where: { id: submissionId }, select: { classroomId: true } });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) return { error: 'Not one of your classes.' };

  await prisma.aIGradingSubmission.delete({ where: { id: submissionId } });
  revalidatePath('/teacher/grading/ai-grader');
  return { success: 'Deleted.' };
}

export async function setTeacherOverrideScore(submissionId: string, score: number | null): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };
  const submission = await prisma.aIGradingSubmission.findUnique({ where: { id: submissionId }, select: { classroomId: true } });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) return { error: 'Not one of your classes.' };

  await prisma.aIGradingSubmission.update({
    where: { id: submissionId },
    data: { teacherOverrideScore: score, teacherOverrideQuestionScores: score === null ? undefined : Prisma.JsonNull },
  });
  revalidatePath('/teacher/grading/ai-grader');
  return { success: score === null ? 'Override cleared.' : 'Score overridden.' };
}

export async function setTeacherOverrideQuestionScore(
  submissionId: string,
  questionNumber: number,
  score: number | null
): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };
  const submission = await prisma.aIGradingSubmission.findUnique({
    where: { id: submissionId },
    select: { classroomId: true, teacherOverrideQuestionScores: true },
  });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) return { error: 'Not one of your classes.' };

  const current = (submission.teacherOverrideQuestionScores as Record<string, number> | null) ?? {};
  const next = { ...current };
  if (score === null) delete next[questionNumber];
  else next[questionNumber] = score;

  await prisma.aIGradingSubmission.update({
    where: { id: submissionId },
    data: {
      teacherOverrideQuestionScores: Object.keys(next).length ? next : Prisma.JsonNull,
      teacherOverrideScore: Object.keys(next).length ? null : undefined,
    },
  });
  revalidatePath('/teacher/grading/ai-grader');
  return { success: 'Saved.' };
}

export async function setTeacherFeedback(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };
  const submissionId = String(formData.get('submissionId') ?? '');
  const feedback = String(formData.get('teacherFeedback') ?? '');

  const submission = await prisma.aIGradingSubmission.findUnique({ where: { id: submissionId }, select: { classroomId: true } });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) return { error: 'Not one of your classes.' };

  await prisma.aIGradingSubmission.update({ where: { id: submissionId }, data: { teacherFeedback: feedback } });
  revalidatePath('/teacher/grading/ai-grader');
  return { success: 'Feedback saved.' };
}

/**
 * Publish a reviewed AI grading submission to the family-facing gradebook.
 *
 * The final IB 1-7 grade is entered by the teacher here, not auto-computed
 * from a percentage — real IB grade boundaries are set per subject/session
 * and are not a fixed formula, and AssessmentResult.grade has no field for
 * "raw score" to fall back on, only a required 1-7 Int. This is the same
 * thing a teacher already does in the manual gradebook; the AI grader gets
 * them to an informed number faster, it does not invent the number itself.
 */
export async function publishResult(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const c = await ctx();
  if (!c) return { error: 'Your staff record is missing.' };

  const submissionId = String(formData.get('submissionId') ?? '');
  const gradeRaw = String(formData.get('grade') ?? '').trim();
  const type = String(formData.get('type') ?? 'SUMMATIVE');
  const comment = String(formData.get('comment') ?? '').trim();

  const submission = await prisma.aIGradingSubmission.findUnique({ where: { id: submissionId } });
  if (!submission || !c.teacher.classes.some(k => k.id === submission.classroomId)) return { error: 'Not one of your classes.' };
  if (!submission.studentId) return { error: 'Assign a student to this sheet before publishing (see the bulk-upload queue).' };
  if (!['EVALUATED', 'NEEDS_REVIEW'].includes(submission.status)) return { error: 'This submission is not ready to publish.' };

  const grade = Number(gradeRaw);
  if (!Number.isInteger(grade) || grade < 1 || grade > 7) return { error: `IB grades run 1 to 7 — "${gradeRaw}" is not one.` };
  if (!['FORMATIVE', 'SUMMATIVE', 'MOCK', 'IA_DRAFT', 'ORAL'].includes(type)) return { error: 'Choose an assessment type.' };

  const student = await prisma.student.findUnique({
    where: { id: submission.studentId },
    select: { id: true, name: true, userId: true, parent: { select: { userId: true } } },
  });
  if (!student) return { error: 'That student could not be found.' };

  const existing = await prisma.assessmentResult.findFirst({
    where: { studentId: student.id, title: submission.title, term: submission.term },
    select: { id: true },
  });

  const date = new Date();
  const assessmentResult = existing
    ? await prisma.assessmentResult.update({
        where: { id: existing.id },
        data: { grade, comment, subjectName: submission.subjectName, type, date },
      })
    : await prisma.assessmentResult.create({
        data: {
          studentId: student.id,
          subjectName: submission.subjectName,
          title: submission.title,
          type,
          date,
          grade,
          maxGrade: 7,
          comment,
          term: submission.term,
        },
      });

  await prisma.aIGradingSubmission.update({
    where: { id: submissionId },
    data: { status: 'PUBLISHED', assessmentResultId: assessmentResult.id, teacherFeedback: comment },
  });

  const rows: { userId: string; title: string; message: string; type: string }[] = [];
  const message = `${submission.title} (${submission.term}): ${grade}/7.${comment ? ` ${comment}` : ''}`;
  if (student.userId) rows.push({ userId: student.userId, title: 'New grade published', message, type: 'INFO' });
  if (student.parent?.userId) {
    rows.push({ userId: student.parent.userId, title: `${student.name}: new grade published`, message, type: 'INFO' });
  }
  if (rows.length) await prisma.notification.createMany({ data: rows });

  revalidatePath('/teacher/grading/ai-grader');
  revalidatePath('/teacher/grading');
  revalidatePath('/teacher/reports');
  revalidatePath('/student/grades');

  return {
    success: `Published — grade ${grade}/7 saved` + (rows.length ? ` and ${rows.length} notification${rows.length === 1 ? '' : 's'} sent.` : '.'),
  };
}

