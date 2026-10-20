import { get, put } from '@vercel/blob';

/** Uploads a scanned answer sheet (PDF, image, Word doc, or plain text) to Vercel Blob and
 *  returns its private URL. Only the URL is ever stored on AIGradingSubmission - matches how
 *  Homework.attachmentUrl/HomeworkSubmission.attachmentUrl are modeled elsewhere in this schema
 *  (a URL column, never a binary column). The blob's declared content type must match the real
 *  file (not always PDF now) so the browser handles/previews it correctly. */
export async function uploadAnswerSheet(file: Buffer, fileName: string, contentType: string): Promise<string> {
  const blob = await put(`answer-sheets/${Date.now()}-${fileName}`, file, {
    access: 'private',
    contentType
  });
  return blob.url;
}

/** Reads a private answer sheet on the server. The returned stream must only be sent through
 *  an authenticated route; never expose the Blob URL to the browser. */
export async function readAnswerSheet(fileUrl: string) {
  const blob = await get(fileUrl, { access: 'private' });
  if (!blob || blob.statusCode !== 200) throw new Error('Stored answer sheet was not found.');
  return {
    stream: blob.stream,
    contentType: blob.blob.contentType,
    fileName: decodeURIComponent(blob.blob.pathname.split('/').pop() ?? 'answer-sheet')
  };
}

