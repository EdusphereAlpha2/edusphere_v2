import type { OcrResult } from './ocr';

const CONVERT_URL = 'https://www.datalab.to/api/v1/convert';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

type JsonRecord = Record<string, unknown>;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readJson(response: Response, stage: string): Promise<JsonRecord> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Chandra OCR ${stage} returned a non-JSON response.`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Chandra OCR ${stage} returned an invalid response.`);
  }

  return payload as JsonRecord;
}

function apiError(payload: JsonRecord, fallback: string): string {
  const message = payload.error ?? payload.message ?? payload.detail;
  return typeof message === 'string' && message.trim()
    ? `Chandra OCR: ${message.slice(0, 500)}`
    : fallback;
}

function ocrResult(markdown: string): OcrResult {
  const text = markdown.trim();
  if (!text) throw new Error('Chandra OCR completed but found no readable text.');

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .map(text => ({ text }));

  return {
    text,
    // Markdown preserves reading order and layout (including tables); Chandra's Convert
    // endpoint does not return the page preview image shape used by PaddleOCR.
    pages: [{ lines }],
    ocrConfidence: null,
  };
}

function checkedPollUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Chandra OCR response did not include a status URL.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Chandra OCR returned an invalid status URL.');
  }

  // The API key is sent on polls too. Only send it back to Datalab's HTTPS Convert endpoint.
  if (url.origin !== 'https://www.datalab.to' || !url.pathname.startsWith('/api/v1/convert/')) {
    throw new Error('Chandra OCR returned an unexpected status URL.');
  }

  return url.toString();
}

/** Sends a scanned PDF or image to Datalab Convert (Chandra) and returns its Markdown as the
 *  same OcrResult shape used by the AI Grader. The API key stays server-side. */
export async function runChandraOcr(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<OcrResult> {
  const apiKey = process.env.DATALAB_API_KEY;
  if (!apiKey) throw new Error('Server is missing DATALAB_API_KEY for Chandra OCR.');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), fileName);
  form.append('output_format', 'markdown');
  form.append('mode', 'balanced');
  form.append('paginate', 'true');

  let submitResponse: Response;
  try {
    submitResponse = await fetch(CONVERT_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach Chandra OCR: ${(error as Error).message}`);
  }

  const submission = await readJson(submitResponse, 'submission');
  if (!submitResponse.ok || submission.success === false) {
    throw new Error(apiError(submission, `Chandra OCR submission failed (status ${submitResponse.status}).`));
  }

  const checkUrl = checkedPollUrl(submission.request_check_url);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let consecutiveNetworkFailures = 0;
  const MAX_CONSECUTIVE_NETWORK_FAILURES = 5;

  while (Date.now() < deadline) {
    let pollResponse: Response;
    try {
      pollResponse = await fetch(checkUrl, {
        headers: { 'X-Api-Key': apiKey },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      consecutiveNetworkFailures = 0;
    } catch (error) {
      consecutiveNetworkFailures++;
      if (consecutiveNetworkFailures >= MAX_CONSECUTIVE_NETWORK_FAILURES) {
        throw new Error(`Could not check Chandra OCR status after ${MAX_CONSECUTIVE_NETWORK_FAILURES} attempts: ${(error as Error).message}`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const result = await readJson(pollResponse, 'status check');
    if (!pollResponse.ok) {
      throw new Error(apiError(result, `Chandra OCR status check failed (status ${pollResponse.status}).`));
    }

    const status = result.status;
    if (status === 'failed' || result.success === false) {
      throw new Error(apiError(result, 'Chandra OCR could not process this file.'));
    }

    if (status === 'complete') {
      if (typeof result.markdown !== 'string') {
        throw new Error('Chandra OCR completed without returning Markdown text.');
      }
      return ocrResult(result.markdown);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for Chandra OCR to finish.');
}

