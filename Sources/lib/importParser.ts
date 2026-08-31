import type { EntryDraft } from "./types";

export interface ImportIssue { row: number; message: string; raw: string }
export interface ParsedImport { entries: EntryDraft[]; issues: ImportIssue[] }

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (quoted) throw new Error("닫히지 않은 CSV 따옴표가 있습니다.");
  return rows;
}

export function parseEntryText(input: string): ParsedImport {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  let rows: string[][];
  try { rows = parseDelimited(text, delimiter); }
  catch (error) { return { entries: [], issues: [{ row: 1, message: String(error), raw: firstLine }] }; }

  const entries: EntryDraft[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((fields, index) => {
    const raw = fields.join(delimiter);
    if (fields.every((value) => !value.trim())) return;
    if (index === 0 && /^(term|word|일본어)$/i.test(fields[0]?.trim() ?? "") && /^(meaning|meanings|뜻|한국어)$/i.test(fields[1]?.trim() ?? "")) return;
    const term = fields[0]?.trim() ?? "";
    const meaningCell = fields[1]?.trim() ?? "";
    const reading = fields[2]?.trim() || undefined;
    if (!term || !meaningCell) {
      issues.push({ row: index + 1, message: !term ? "단어가 비어 있습니다." : "뜻이 비어 있습니다.", raw });
      return;
    }
    const meanings = meaningCell.split("/").map((value) => value.trim()).filter(Boolean);
    const key = `${term}\u0000${meanings.join("\u0000")}\u0000${reading ?? ""}`;
    if (seen.has(key)) {
      issues.push({ row: index + 1, message: "입력 안의 중복 행입니다.", raw });
      return;
    }
    seen.add(key);
    entries.push({ term, meanings, reading });
  });
  return { entries, issues };
}
