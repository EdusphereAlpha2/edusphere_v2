import mammoth from 'mammoth';
import { runChandraOcr } from './chandra';
import { runOcr, type OcrResult } from './ocr';

/** Answer sheets teachers actually have on hand aren't always a scanned PDF - some are typed up
 *  as a Word document, pasted as plain text, or photographed on a phone as a JPEG/PNG. This is
 *  the single entry point runGrading (actions.ts) calls instead of runOcr directly, so every
 *  format lands on the same OcrResult shape (text + per-page lines) the rest of the grading
 *  pipeline (buildMarkedOcrText, the annotation line-numbering, the Annotated-paper tab) already
 *  understands - none of that code needs to know or care which format the file arrived in. */

export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.jpg', '.jpeg', '.png', '.webp'];

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LEGACY_DOC_MIME_TYPE = 'application/msword';

export function isAcceptedAnswerSheet(fileName: string, mimeType: string): boolean {
  const ext = extensionOf(fileName);
  if (mimeType === 'application/pdf' || ext === '.pdf') return true;
  if (mimeType === DOCX_MIME_TYPE || ext === '.docx') return true;
  if (mimeType.startsWith('text/plain') || ext === '.txt') return true;
  if (IMAGE_MIME_TYPES.has(mimeType) || ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return true;
  return false;
}

export function isLegacyDoc(fileName: string, mimeType: string): boolean {
  return mimeType === LEGACY_DOC_MIME_TYPE || extensionOf(fileName) === '.doc';
}

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i === -1 ? '' : fileName.slice(i).toLowerCase();
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': DOCX_MIME_TYPE,
  '.doc': LEGACY_DOC_MIME_TYPE,
  '.txt': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Used only where a real File.type isn't available - e.g. retrying a submission from its
 *  already-stored blob URL, which carries a filename but not the original browser-reported MIME
 *  type. extractAnswerText itself falls back to extension checks regardless, so this only
 *  matters for picking the right Blob content-type to send PaddleOCR for PDFs/images. */
export function guessMimeType(fileName: string): string {
  return EXTENSION_MIME_TYPES[extensionOf(fileName)] ?? 'application/octet-stream';
}

/** Splits already-digital text (plain text, or extracted from a Word doc) into the same
 *  { text, pages, ocrConfidence } shape OCR produces, so downstream code is format-agnostic.
 *  Treated as a single page: there is no real per-page structure to recover from a .txt file,
 *  and mammoth does not preserve Word's page breaks (they are a rendering artifact of page
 *  size/margins, not stored as explicit markers) - the same simplification this codebase
 *  already makes for a holistic Extended Essay/TOK PDF, which is graded as one continuous piece
 *  rather than split into pages. ocrConfidence is null throughout: nothing here was OCR'd, so
 *  there is no recognition-confidence score to report, and the low-confidence NEEDS_REVIEW
 *  check in actions.ts is a no-op for these formats as a result. */
function fromDigitalText(rawText: string): OcrResult {
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(text => ({ text }));
  if (lines.length === 0) throw new Error('The file appears to be empty.');
  return {
    text: lines.map(l => l.text).join('\n'),
    pages: [{ lines }],
    ocrConfidence: null,
  };
}

/** Extracts gradable text from any accepted answer-sheet format. Throws a plain Error with a
 *  message safe to show a teacher, same contract as runOcr. */
export async function extractAnswerText(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<OcrResult> {
  if (isLegacyDoc(fileName, mimeType)) {
    throw new Error('Old-style .doc files are not supported - re-save as .docx (Word: File > Save As > Word Document) and re-upload.');
  }

  const ext = extensionOf(fileName);

  if (mimeType.startsWith('text/plain') || ext === '.txt') {
    return fromDigitalText(fileBuffer.toString('utf-8'));
  }

  if (mimeType === DOCX_MIME_TYPE || ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
    return fromDigitalText(value);
  }

  // Use Chandra when configured; retain PaddleOCR for deployments without a Datalab key.
  if (process.env.DATALAB_API_KEY) {
    return runChandraOcr(fileBuffer, fileName, mimeType || 'application/octet-stream');
  }

  // PDF and images both go through PaddleOCR - it accepts either through the same endpoint.
  return runOcr(fileBuffer, fileName, mimeType || 'application/octet-stream');
}

