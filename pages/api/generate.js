// pages/api/generate.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Extract code blocks and optional filename comments
function extractCodeBlocks(markdown) {
  const blocks = [];
  if (!markdown || typeof markdown !== "string") return blocks;
  const regex = /```(\w+)\n([\s\S]*?)```/g;
  let m;
  while ((m = regex.exec(markdown)) !== null) {
    const lang = m[1].toLowerCase();
    const code = m[2];
    const fileMatch = code.match(/file:\s*(.+)\n/i);
    blocks.push({
      lang,
      code,
      filename: fileMatch ? fileMatch[1].trim() : null,
      fullBlock: m[0],
    });
  }
  return blocks;
}

function replaceBlockByFilename(base, filename, newBlock) {
  if (!filename) return { updated: base, replaced: false };
  const regex = new RegExp("```[\\w-]+\\n[\\s\\S]*?file:\\s*" + filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?```", "i");
  if (regex.test(base)) {
    return { updated: base.replace(regex, newBlock), replaced: true };
  }
  return { updated: base, replaced: false };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, previousCode = "", model = "gemini-2.5-flash" } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const modelInstance = genAI.getGenerativeModel({ model });

    const systemPrompt = previousCode
      ? `
You are an AI code builder. You have this existing project:
${previousCode}

Update or add files based on:
"${prompt}"

Rules:
- Output ONLY markdown code blocks.
- Each block must start with its language fence (\`\`\`html, \`\`\`js, etc.).
- Include a comment "// file: filename.ext" on the first line for each block.
- Do NOT add explanations.
- Only include updated or new files.
`
      : `
You are an AI code builder.
Generate a full working project for this request:
"${prompt}"

Rules:
- Output ONLY markdown code blocks.
- Each block must start with its language fence (\`\`\`html, \`\`\`js, etc.).
- Include a comment "// file: filename.ext" at the top of each code block.
- If web app: ensure complete <html><head><body>.
- No explanations outside code.
`;

    const result = await modelInstance.generateContent({ prompt: systemPrompt });
    const output = result.candidates?.[0]?.content || "";

    if (!output.trim()) return res.status(500).json({ error: "AI returned empty output" });

    const aiBlocks = extractCodeBlocks(output);
    let merged = previousCode || "";

    for (const blk of aiBlocks) {
      const newFullBlock = `\`\`\`${blk.lang}\n${blk.code}\n\`\`\``;
      let replaced = false;
      if (blk.filename) {
        const rep = replaceBlockByFilename(merged, blk.filename, newFullBlock);
        merged = rep.updated;
        replaced = rep.replaced;
      }
      if (!replaced) {
        merged += "\n\n" + newFullBlock;
      }
    }

    if (aiBlocks.length === 0) merged += "\n\n" + output;

    return res.status(200).json({
      output: merged,
      aiRaw: output,
      aiBlocksCount: aiBlocks.length,
    });
  } catch (err) {
    console.error("AI request failed:", err);
    return res.status(500).json({ error: err.message });
  }
}
