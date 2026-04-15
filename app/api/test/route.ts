import { NextResponse } from "next/server";

export async function GET() {
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
        messages: [{ role: "user", content: "say hello" }],
        enable_thinking: false,
      }),
    }
  );

  const data = await res.json();
  return NextResponse.json(data);
}
