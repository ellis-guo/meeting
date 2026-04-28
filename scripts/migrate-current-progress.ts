/**
 * One-shot migration: wrap legacy single-object `current_progress` into an array.
 *
 * Background:
 *   In Phase 6 the schema for `current_progress` changed from
 *   `{ summary, as_of } | null` to `Array<{ summary, as_of }> | null`.
 *   Diff entries written before that change left some Project.document rows
 *   with a single-object `current_progress`. This script normalizes them.
 *
 * Run:
 *   npx -y tsx --env-file=.env.local scripts/migrate-current-progress.ts
 *
 * Idempotent: rows already in the array form are skipped.
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
  let errored = 0;

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
      errored++;
      continue;
    }

    const cp = doc.current_progress;
    if (cp === null || cp === undefined) {
      skipped++;
      continue;
    }
    if (Array.isArray(cp)) {
      skipped++;
      continue;
    }
    if (typeof cp !== "object") {
      console.warn(`[SKIP] ${p.id} (${p.name}): current_progress is ${typeof cp}, not object — leaving as is`);
      skipped++;
      continue;
    }

    // Single-object form → wrap into array
    const wrapped = [cp];
    doc.current_progress = wrapped;

    await prisma.project.update({
      where: { id: p.id },
      data: { document: encryptJSON(doc) },
    });

    console.log(`[FIX] ${p.id} (${p.name}): wrapped into array (1 entry)`);
    fixed++;
  }

  console.log("\n=== Summary ===");
  console.log(`Fixed:   ${fixed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errored: ${errored}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
