import { NextRequest, NextResponse } from "next/server";

const RULES = `RULES:
1. Only record what was explicitly stated or decided. Never infer attitudes, emotions, or character.
2. Never write judgmental statements like "X showed a lack of confidence" or "this exposes poor communication".
3. source_lines must reference real line numbers from the transcript — never fabricate them.
4. Output ONLY valid JSON. No markdown, no code blocks, no explanation.
5. Detect the dominant language of the transcript and write all summary text in that language. For mixed-language transcripts, use the dominant language but preserve specific technical terms, academic vocabulary, or proper nouns in their original language as used in the transcript.
6. Be concise and structured. Avoid colloquial or verbose phrasing. Use formal written Chinese.
7. For all text fields, prefer phrases over full sentences.`;

const CONTENT_TYPE_GUIDE = `CONTENT TYPES — choose the most appropriate type for each section's content:
- "text": a single paragraph or statement (e.g. meeting overview, a brief conclusion)
- "bullets": multiple distinct points. Each bullet may optionally have sub_items for nested detail.
- "table": when content has clear uniform columns across all rows (e.g. person / task / deadline). Only use table when ALL rows share the same column structure.

Schema for each type:
  { "type": "text", "value": "string", "source_lines": [number] }
  { "type": "bullets", "items": [{ "text": "string", "source_lines": [number], "sub_items": [{ "text": "string", "source_lines": [number] }] }] }
  { "type": "table", "columns": ["string"], "rows": [{ "cells": ["string"], "source_lines": [number] }] }

Note: sub_items is optional. Use it when a bullet point contains multiple distinct sub-points — do NOT collapse them with semicolons.`;

const SHARED_SCHEMA = `OUTPUT SCHEMA:
{
  "meta": {
    "date": "string or null",
    "time": "string or null",
    "participants": ["string"]
  },
  "sections": [
    {
      "title": "string",
      "content": <one of the three content types above>
    }
  ],
  "humanistic_note": "string or null"
}`;

const SMART_PROMPT = `You are a meeting summarization assistant. Analyze the transcript and produce a structured summary.

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

GUIDELINES:
- meta.date: extract from transcript or context if mentioned, otherwise null
- meta.time: extract meeting start time from transcript if mentioned, otherwise null
- meta.participants: extract all speaker names from the transcript
- sections: decide freely how many sections, what to title them, and which content type best presents each section's data
- The main discussion content is the core of the summary — cover it thoroughly with sufficient detail and sub-points
- humanistic_note: if someone mentioned illness, stress, fatigue, or a personal hardship, write one warm sentence speaking directly to that person, as if the tool itself cares about them; otherwise null`;

const PROJECT_PROMPT = `You are a meeting summarization assistant. Analyze the transcript and produce a structured summary for a project progress meeting.

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

GUIDELINES:
- meta.date: extract from transcript or context if mentioned, otherwise null
- meta.time: extract meeting start time from transcript if mentioned, otherwise null
- meta.participants: extract all speaker names from the transcript
- sections: always include the following (skip only if truly not applicable):
    1. 会议概述 — "text" type; one short paragraph
    2. 议题详情 — the most important section; cover every topic discussed with full detail; use sub_items to break down multi-point topics; do not collapse distinct points with semicolons
    3. 行动项 — "table" if all items have uniform owner/task structure; otherwise "bullets"; keep task descriptions concise
    4. 下次会议 — "text" type; only if mentioned
    5. 其他 — "text" type; only if applicable
  You may add additional sections if warranted.
- The 议题详情 section should be the longest and most detailed section in the summary.
- humanistic_note: if someone mentioned illness, stress, fatigue, or a personal hardship, write one warm sentence speaking directly to that person, as if the tool itself cares about them; otherwise null`;

function addLineNumbers(transcript: string): string {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, i) => `[${i + 1}] ${line}`).join("\n");
}

export async function POST(req: NextRequest) {
  const { transcript, template = "smart", date, time } = await req.json();

  const numbered = addLineNumbers(transcript);
  const systemPrompt = template === "project" ? PROJECT_PROMPT : SMART_PROMPT;

  const contextLines = [
    date ? `Meeting date: ${date}` : null,
    time ? `Meeting time: ${time}` : null,
    `Here is the meeting transcript:\n\n${numbered}`,
  ].filter(Boolean).join("\n");

  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: contextLines },
        ],
        enable_thinking: false,
      }),
    }
  );

  const data = await res.json();
  const content = data.choices[0].message.content;
  const summary = JSON.parse(content);

  return NextResponse.json({ numbered_transcript: numbered, summary });
}
