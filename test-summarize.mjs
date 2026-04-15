import { readFileSync } from "fs";

const transcript = readFileSync(
  "../scripts/20260402043225-Transcription_Started by 米尔-逐字稿文本-1.txt",
  "utf-8"
);

const res = await fetch("http://localhost:3000/api/summarize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transcript, template: "project", date: "2026-04-02" }),
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
