/**
 * One-shot cleanup: remove the deprecated `current_progress` field from
 * Project.document for all projects.
 *
 * Run:
 *   npx -y tsx --env-file=.env.local scripts/migrate-remove-current-progress.ts
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { decryptJSON, encryptJSON } from "../lib/crypto";

const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, document: true },
  });

  console.log(`Scanning ${projects.length} projects...`);

  let fixed = 0;
  let skipped = 0;

  for (const p of projects) {
    if (!p.document) {
      skipped++;
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      doc = decryptJSON<Record<string, unknown>>(p.document);
    } catch (e) {
      console.error(`[ERR] decrypt failed for ${p.id} (${p.name}):`, e);
      continue;
    }
    if (!("current_progress" in doc)) {
      skipped++;
      continue;
    }
    delete doc.current_progress;
    await prisma.project.update({
      where: { id: p.id },
      data: { document: encryptJSON(doc) },
    });
    console.log(`[FIX] ${p.id} (${p.name}): removed current_progress`);
    fixed++;
  }

  console.log("\n=== Summary ===");
  console.log(`Fixed:   ${fixed}`);
  console.log(`Skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
