import prisma from '@/lib/prisma';
import { guard, TEACHER_ROLES } from '@/lib/authz';
import { readAnswerSheet } from '@/lib/grading/storage';

export const dynamic = 'force-dynamic';

/** Streams an AI Grader original file only to a signed-in teacher assigned to its class.
 *  The underlying private Blob URL and token never reach the browser. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await guard(TEACHER_ROLES);
  if (!auth.ok) return new Response('Please sign in with a teacher account.', { status: 403 });

  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({
    where: { userId: auth.user.id },
    select: { classes: { select: { id: true } } }
  });
  if (!teacher) return new Response('Your staff record is missing.', { status: 403 });

  const submission = await prisma.aIGradingSubmission.findUnique({
    where: { id },
    select: { classroomId: true, fileUrl: true, originalFileName: true }
  });
  if (!submission || !teacher.classes.some(c => c.id === submission.classroomId)) {
    return new Response('File not found.', { status: 404 });
  }

  try {
    const file = await readAnswerSheet(submission.fileUrl);
    const fileName = submission.originalFileName || file.fileName;
    const fallbackName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return new Response(file.stream, {
      headers: {
        'Content-Type': file.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return new Response('Could not load the stored file.', { status: 502 });
  }
}

