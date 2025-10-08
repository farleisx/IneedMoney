// pages/api/generate.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper: extract code blocks -> [{lang, code, fullBlock}]
function extractCodeBlocks(markdown) {
  const blocks = [];
  if (!markdown || typeof markdown !== "string") return blocks;
  const regex = /```(\w+)\n([\s\S]*?)```/g;
  let m;
  while ((m = regex.exec(markdown)) !== null) {
    blocks.push({
      lang: m[1].toLowerCase(),
      code: m[2],
      fullBlock: m[0],
    });
  }
  return blocks;
}

// Helper: replace the first code block of a given language in `base` with `newBlock`.
// Returns {updated: string, replaced: boolean}
function replaceFirstCodeBlockByLang(base, lang, newBlock) {
  const regex = new RegExp("```" + lang + "\\n[\\s\\S]*?```", "i");
  if (regex.test(base)) {
    const updated = base.replace(regex, newBlock);
    return { updated, replaced: true };
  }
  return { updated: base, replaced: false };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const prompt = body.prompt;
    const previousCode = body.previousCode || "";
    // Optional tuning params (safe defaults)
    const modelName = body.model || "gemini-2.5-flash";
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.2;
    const maxOutputTokens = typeof body.maxOutputTokens === "number" ? body.maxOutputTokens : 2000;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid prompt" });
    }

    // Build instruction prompt for Gemini
    let requestPrompt = "";
    if (previousCode && previousCode.trim() !== "") {
      requestPrompt = `
You are an AI code builder agent. You have the following existing code (which may include multiple files and code blocks):
---
${previousCode}
---

The user asks to update or add features according to:
"${prompt}"

Rules:
1) Return ONLY markdown-wrapped code blocks for the files/sections you modify or add, using language fences like \`\`\`js\`\`\`, \`\`\`html\`\`\`, \`\`\`python\`\`\`, etc.
2) For updates: name the language accurately in the fence (e.g. \`\`\`javascript\`\`\` or \`\`\`js\`\`\`).
3) If you add new files, wrap them as code blocks too. You can include filename comments inside the code block if helpful (e.g. // file: src/index.js).
4) Do NOT output explanation text outside code fences. Inline comments in code are allowed.
5) Only update or add what's necessary for the requested feature.
`;
    } else {
      requestPrompt = `
You are an AI code builder agent.
Generate a FULL working project for this request:
"${prompt}"

Rules:
1) Return ONLY markdown-wrapped code blocks with correct language fences.
2) If generating a web app, include complete HTML pages where needed (<html><head><body>).
3) Do NOT add explanations outside code fences. Inline comments inside code are allowed.
`;
    }

    // Instantiate model
    const model = genAI.getGenerativeModel({ model: modelName });

    // Call Gemini - shape: result.candidates[0].content
    const result = await model.generateContent({
      prompt: requestPrompt,
      temperature,
      max_output_tokens: maxOutputTokens,
    });

    // Extract AI content robustly
    const fullOutput = result?.candidates?.[0]?.content ?? result?.output?.[0]?.content ?? "";

    if (!fullOutput || fullOutput.trim() === "") {
      return res.status(500).json({ error: "AI returned empty output", details: result ?? null });
    }

    // Parse code blocks from AI output and previousCode
    const aiBlocks = extractCodeBlocks(fullOutput);
    const baseBlocks = extractCodeBlocks(previousCode);

    // Start with previousCode as base for replacements
    let merged = previousCode || "";

    // For each aiBlock try to replace the first matching language block in merged
    // If no matching block found, append the new block at the end.
    const replacedLangs = {};
    for (const blk of aiBlocks) {
      const lang = blk.lang;
      const newFullBlock = "```" + lang + "\n" + blk.code + "\n```";

      // Strategy: If we haven't already replaced a block with this language, try replace;
      // otherwise append (this prevents multiple replacements colliding).
      if (!replacedLangs[lang]) {
        const { updated, replaced } = replaceFirstCodeBlockByLang(merged, lang, newFullBlock);
        if (replaced) {
          merged = updated;
          replacedLangs[lang] = true;
          continue;
        }
      }

      // If we reach here, we couldn't replace — append the block
      merged += "\n\n" + newFullBlock;
      replacedLangs[lang] = true;
    }

    // If user provided previousCode but AI returned no code fences (edge case),
    // append the raw AI output so user can inspect it.
    const aiHasCode = aiBlocks.length > 0;
    if (!aiHasCode) {
      merged += "\n\n" + fullOutput;
    }

    // Return merged result and the AI raw output as well
    return res.status(200).json({
      output: merged,
      aiRaw: fullOutput,
      aiBlocksCount: aiBlocks.length,
      replacedLangs: Object.keys(replacedLangs),
    });
  } catch (err) {
    console.error("AI request failed:", err);
    return res.status(500).json({ error: "AI request failed", details: err?.message ?? String(err) });
  }
}
